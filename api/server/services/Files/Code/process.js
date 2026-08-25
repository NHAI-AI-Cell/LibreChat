const path = require('path');
const { v4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { getCodeBaseURL } = require('@librechat/agents');
const {
  getBasePath,
  logAxiosError,
  sanitizeArtifactPath,
  flattenArtifactPath,
  createAxiosInstance,
  getCodeApiAuthHeaders,
  classifyCodeArtifact,
  codeServerHttpAgent,
  codeServerHttpsAgent,
  extractCodeArtifactText,
  getExtractedTextFormat,
  getStorageMetadata,
  buildCodeEnvDownloadQuery,
} = require('@librechat/api');
const {
  Tools,
  megabyte,
  fileConfig,
  FileContext,
  FileSources,
  imageExtRegex,
  inferMimeType,
  EToolResources,
  EModelEndpoint,
  mergeFileConfig,
  classifyGeneratedFile,
  getEndpointFileConfig,
} = require('librechat-data-provider');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { createFile, getFiles, updateFile, claimCodeFile } = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { convertImage } = require('~/server/services/Files/images/convert');
const { getRetentionExpiry } = require('~/server/services/Files/retention');
const { determineFileType } = require('~/server/utils');

const axios = createAxiosInstance();

/**
 * Creates a fallback download URL response when file cannot be processed locally.
 * Used when: file exceeds size limit, storage strategy unavailable, or download error occurs.
 * @param {Object} params - The parameters.
 * @param {string} params.name - The filename.
 * @param {string} params.session_id - The code execution session ID.
 * @param {string} params.id - The file ID from the code environment.
 * @param {string} params.conversationId - The current conversation ID.
 * @param {string} params.toolCallId - The tool call ID that generated the file.
 * @param {string} params.messageId - The current message ID.
 * @param {number} params.expiresAt - Expiration timestamp (24 hours from creation).
 * @returns {Object} Fallback response with download URL.
 */
const createDownloadFallback = ({
  id,
  name,
  messageId,
  expiresAt,
  session_id,
  toolCallId,
  conversationId,
}) => {
  const basePath = getBasePath();
  return {
    filename: name,
    filepath: `${basePath}/api/files/code/download/${session_id}/${id}`,
    expiresAt,
    conversationId,
    toolCallId,
    messageId,
  };
};

/**
 * Process code execution output files — downloads and saves both images
 * and non-image files. All files are saved to local storage with
 * `codeEnvRef` metadata for code env re-upload.
 *
 * Office-style formats are persisted download-only. Other non-image
 * files keep the existing reliable text extraction behavior.
 *
 * @param {ServerRequest} params.req - The Express request object.
 * @param {string} params.id - The file ID from the code environment.
 * @param {string} params.name - The filename.
 * @param {string} params.toolCallId - The tool call ID that generated the file.
 * @param {string} params.session_id - The code execution session ID.
 * @param {string} params.conversationId - The current conversation ID.
 * @param {string} params.messageId - The current message ID.
 * @returns {Promise<{ file: MongoFile & { messageId: string, toolCallId: string } }>}
 */
const processCodeOutput = async ({
  req,
  id,
  name,
  toolCallId,
  conversationId,
  messageId,
  session_id,
}) => {
  const appConfig = req.config;
  const currentDate = new Date();
  const baseURL = getCodeBaseURL();
  const fileExt = path.extname(name).toLowerCase();
  const isImage = fileExt && imageExtRegex.test(name);

  const mergedFileConfig = mergeFileConfig(appConfig.fileConfig);
  const endpointFileConfig = getEndpointFileConfig({
    fileConfig: mergedFileConfig,
    endpoint: EModelEndpoint.agents,
  });
  const fileSizeLimit = endpointFileConfig.fileSizeLimit ?? mergedFileConfig.serverFileSizeLimit;

  try {
    const formattedDate = currentDate.toISOString();
    const authHeaders = await getCodeApiAuthHeaders(req);
    /* Code-output files are always user-private — no skill execution
     * produces a skill-scoped output bucket. The download URL must
     * carry `?kind=user&id=<userId>` so codeapi's `sessionAuth`
     * resolves the matching `<tenant>:user:<userId>` sessionKey. See
     * codeapi #1455 / Phase C. */
    const downloadQuery = buildCodeEnvDownloadQuery({ kind: 'user', id: req.user.id });
    const response = await axios({
      method: 'get',
      url: `${baseURL}/download/${session_id}/${id}${downloadQuery}`,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 15000,
    });

    const buffer = Buffer.from(response.data, 'binary');

    // Enforce file size limit
    if (buffer.length > fileSizeLimit) {
      logger.warn(
        `[processCodeOutput] File "${name}" (${(buffer.length / megabyte).toFixed(2)} MB) exceeds size limit of ${(fileSizeLimit / megabyte).toFixed(2)} MB, falling back to download URL`,
      );
      return {
        file: createDownloadFallback({
          id,
          name,
          messageId,
          toolCallId,
          session_id,
          conversationId,
          expiresAt: currentDate.getTime() + 86400000,
        }),
      };
    }

    /* Code-output files belong to the user who ran the execution.
     * SessionKey on codeapi will be `<tenant>:user:<userId>` for these,
     * so cache and access stay user-private. */
    const codeEnvRef = {
      kind: 'user',
      id: req.user.id,
      storage_session_id: session_id,
      file_id: id,
    };

    /* `safeName` keeps the directory structure (`a/b/file.txt` -> `a/b/file.txt`)
     * so the next prime() can place the file at the same nested path in the
     * sandbox; flattening would re-create the bug where every nested artifact
     * collapsed into the root and read_file calls 404'd. The flat-form
     * storage key is composed below once `file_id` is known so we can cap
     * the total length at filesystem NAME_MAX. */
    const safeName = sanitizeArtifactPath(name);
    if (safeName !== name) {
      logger.warn(
        `[processCodeOutput] Filename sanitized: "${name}" -> "${safeName}" | conv=${conversationId}`,
      );
    }

    /**
     * Atomically claim a file_id for this (filename, conversationId, context) tuple.
     * Uses $setOnInsert so concurrent calls for the same filename converge on
     * a single record instead of creating duplicates (TOCTOU race fix).
     *
     * Claim by `safeName` (not raw `name`) so the claim and the eventual
     * `createFile` agree on the filename column — otherwise weird inputs
     * (e.g. `"proj name/file@v1.txt"`) would claim under the raw name and
     * then write under the sanitized one, leaving the claim row orphaned.
     */
    const newFileId = v4();
    const claimed = await claimCodeFile({
      filename: safeName,
      conversationId,
      file_id: newFileId,
      user: req.user.id,
      tenantId: req.user.tenantId,
    });
    const file_id = claimed.file_id;
    const isUpdate = file_id !== newFileId;
    // `file_id` identifies the logical filename slot. Each publication gets
    // a new physical object so a stored share snapshot can never follow a
    // later same-name rewrite.
    const publicationId = v4();

    if (isUpdate) {
      logger.debug(
        `[processCodeOutput] Updating existing file "${safeName}" (${file_id}) instead of creating duplicate`,
      );
    }

    /**
     * Preserve the original `messageId` on update. Each `processCodeOutput`
     * call would otherwise overwrite it with the current run's run id, which
     * decouples the file from the assistant message that originally created
     * it. `getCodeGeneratedFiles` filters by `messageId IN <thread>`, so a
     * stale id (e.g. from a later regeneration / failed re-read attempt)
     * silently excludes the file from priming on subsequent turns.
     */
    const persistedMessageId = isUpdate ? (claimed.messageId ?? messageId) : messageId;

    if (isImage) {
      const usage = isUpdate ? (claimed.usage ?? 0) + 1 : 1;
      const _file = await convertImage(
        req,
        buffer,
        'high',
        `${file_id}__${publicationId}${fileExt}`,
      );
      const filepath = usage > 1 ? `${_file.filepath}?v=${Date.now()}` : _file.filepath;
      const storageMetadata = getStorageMetadata({
        filepath: _file.filepath,
        source: appConfig.fileStrategy,
        storageKey: _file.storageKey,
        storageRegion: _file.storageRegion,
      });
      const file = {
        ..._file,
        filepath,
        ...storageMetadata,
        file_id,
        messageId: persistedMessageId,
        usage,
        filename: safeName,
        conversationId,
        user: req.user.id,
        tenantId: req.user.tenantId,
        type: `image/${appConfig.imageOutputType}`,
        createdAt: isUpdate ? claimed.createdAt : formattedDate,
        updatedAt: formattedDate,
        source: appConfig.fileStrategy,
        context: FileContext.execute_code,
        metadata: { codeEnvRef },
        ...(await getRetentionExpiry(req)),
      };
      await createFile(file, true);
      return { file: Object.assign(file, { messageId, toolCallId }) };
    }

    const { saveBuffer } = getStrategyFunctions(appConfig.fileStrategy);
    if (!saveBuffer) {
      logger.warn(
        `[processCodeOutput] saveBuffer not available for strategy ${appConfig.fileStrategy}, falling back to download URL`,
      );
      return {
        file: createDownloadFallback({
          id,
          name,
          messageId,
          toolCallId,
          session_id,
          conversationId,
          expiresAt: currentDate.getTime() + 86400000,
        }),
      };
    }

    const detectedType = await determineFileType(buffer, true);
    const mimeType = detectedType?.mime || inferMimeType(name, '') || 'application/octet-stream';

    /** Check MIME type support - for code-generated files, we're lenient but log unsupported types */
    const isSupportedMimeType = fileConfig.checkType(
      mimeType,
      endpointFileConfig.supportedMimeTypes,
    );
    if (!isSupportedMimeType) {
      logger.warn(
        `[processCodeOutput] File "${name}" has unsupported MIME type "${mimeType}", proceeding with storage but may not be usable as tool resource`,
      );
    }

    /* Compose the storage key here, after `file_id` is known, so the
     * `flattenArtifactPath` cap budget can be calculated against the
     * actual prefix length. The full key has to fit in one filesystem
     * path component (NAME_MAX = 255 on most filesystems); without this
     * cap, deeply-nested artifact paths whose individual segments were
     * within bounds can still produce a flat form that overflows once
     * `${file_id}__${publicationId}__` is prepended, causing `ENAMETOOLONG` inside
     * saveBuffer and falling back to a download URL. The 255 figure is
     * the conservative cross-platform NAME_MAX (Linux ext4, NTFS, APFS).
     */
    const NAME_MAX = 255;
    const storagePrefix = `${file_id}__${publicationId}__`;
    const flatName = flattenArtifactPath(safeName, NAME_MAX - storagePrefix.length);
    const fileName = `${storagePrefix}${flatName}`;
    const filepath = await saveBuffer({
      userId: req.user.id,
      buffer,
      fileName,
      basePath: 'uploads',
      tenantId: req.user.tenantId,
    });
    const storageMetadata = getStorageMetadata({
      filepath,
      source: appConfig.fileStrategy,
    });

    /* `classifyCodeArtifact` and `extractCodeArtifactText` make
     * extension/bare-name decisions on the input string. With the
     * path-preserving sanitizer they can now receive a nested path like
     * `reports.v1/Makefile`, which the classifier's `extensionOf` reads
     * as `v1/Makefile` (the slice after the dot in the directory name)
     * and the bare-name branch rejects because it sees a `.` anywhere in
     * the string. Result: extensionless artifacts under dotted folders
     * (Makefile, Dockerfile, etc.) get misclassified as `other` and
     * skip text extraction. Pass the basename so classification matches
     * what it would have gotten with the old flat-name flow. */
    const leafName = path.basename(safeName);
    const category = classifyCodeArtifact(leafName, mimeType);

    const generatedFilePolicy = classifyGeneratedFile({ filename: leafName, mimeType });

    const baseFile = {
      file_id,
      filepath,
      ...storageMetadata,
      messageId: persistedMessageId,
      object: 'file',
      filename: safeName,
      type: mimeType,
      conversationId,
      user: req.user.id,
      tenantId: req.user.tenantId,
      bytes: buffer.length,
      updatedAt: formattedDate,
      metadata: { codeEnvRef },
      source: appConfig.fileStrategy,
      context: FileContext.execute_code,
      usage: isUpdate ? (claimed.usage ?? 0) + 1 : 1,
      createdAt: isUpdate ? claimed.createdAt : formattedDate,
      ...(await getRetentionExpiry(req)),
    };

    if (generatedFilePolicy.kind === 'download-only') {
      /* The stored binary is the only reliable representation for these
       * formats. Explicit nulls also clear HTML and lifecycle data when a
       * later tool call reuses a filename that was previewed previously. */
      const file = {
        ...baseFile,
        text: null,
        textFormat: null,
        status: null,
        previewError: null,
        previewRevision: null,
      };
      await createFile(file, true);
      return { file: Object.assign(file, { messageId, toolCallId }) };
    }

    /* Existing preview path: extraction is cheap (utf8 decode, parseDocument
     * for PDF/ODT, or null for binaries). Run inline and return a
     * fully-resolved record. */
    const text = await extractCodeArtifactText(buffer, leafName, mimeType, category);
    /* `textFormat` accompanies `text` so clients can distinguish trusted
     * generated markup from plain extracted text. */
    const textFormat = getExtractedTextFormat(leafName, mimeType, text);
    const file = {
      ...baseFile,
      // Always set explicitly so an update which produces a binary or
      // oversized artifact clears any previously cached text — createFile
      // uses findOneAndUpdate with $set semantics.
      text: text ?? null,
      textFormat: textFormat ?? null,
      // Clear legacy preview fields if this file id previously belonged to
      // an Office attachment created by an older server version.
      status: null,
      previewError: null,
      previewRevision: null,
    };

    await createFile(file, true);
    return { file: Object.assign(file, { messageId, toolCallId }) };
  } catch (error) {
    if (error?.message === 'Path traversal detected in filename') {
      logger.warn(
        `[processCodeOutput] Path traversal blocked for file "${name}" | conv=${conversationId}`,
      );
    }
    logAxiosError({
      message: 'Error downloading/processing code environment file',
      error,
    });
    logger.warn(
      `[processCodeOutput] Falling back to Code API download URL for strategy ${appConfig.fileStrategy}`,
    );

    // Fallback for download errors - return download URL so user can still manually download
    return {
      file: createDownloadFallback({
        id,
        name,
        messageId,
        toolCallId,
        session_id,
        conversationId,
        expiresAt: currentDate.getTime() + 86400000,
      }),
    };
  }
};

function checkIfActive(dateString) {
  const givenDate = new Date(dateString);
  const currentDate = new Date();
  const timeDifference = currentDate - givenDate;
  const hoursPassed = timeDifference / (1000 * 60 * 60);
  return hoursPassed < 23;
}

/**
 * Retrieves the `lastModified` time string for a specified file from Code Execution Server.
 *
 * @param {import('librechat-data-provider').CodeEnvRef} ref - Typed pointer
 *   into codeapi storage. Carries kind/id/storage_session_id/file_id;
 *   codeapi resolves the sessionKey from the request's auth context.
 * @param {ServerRequest} [req] - Current authenticated request, used to mint Code API auth.
 *
 * @returns {Promise<string|null>}
 *          A promise that resolves to the `lastModified` time string of the file if successful, or null if there is an
 *          error in initialization or fetching the info.
 */
async function getSessionInfo(ref, req) {
  try {
    const baseURL = getCodeBaseURL();
    const authHeaders = await getCodeApiAuthHeaders(req);
    /* `/sessions/.../objects/...` is gated by codeapi's `sessionAuth`
     * middleware (post-Phase C). The middleware reconstructs the
     * sessionKey from the URL query (`kind`/`id`/`version?`) plus the
     * requester's auth context, then matches it against the cached
     * sessionKey on the storage bucket. We have the full `codeEnvRef`
     * here, so pass kind+id (+version when skill) directly. */
    const query = buildCodeEnvDownloadQuery({
      kind: ref.kind,
      id: ref.id,
      ...(ref.kind === 'skill' ? { version: ref.version } : {}),
    });
    const response = await axios({
      method: 'get',
      url: `${baseURL}/sessions/${ref.storage_session_id}/objects/${ref.file_id}${query}`,
      headers: {
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 5000,
    });

    return response.data?.lastModified;
  } catch (error) {
    logger.debug(
      `[getSessionInfo] session lookup failed (treating as cache miss): ${error?.message ?? String(error)}`,
    );
    return null;
  }
}

const getVisibleCodeFileContextLine = (file, agentResourceIds) => {
  if (file.context === FileContext.execute_code) {
    return '';
  }

  const fileSuffix = agentResourceIds.has(file.file_id) ? '' : ' (attached by user)';
  return `\n\t- /mnt/data/${file.filename}${fileSuffix}`;
};

const appendVisibleCodeFileContext = (toolContext, contextLine) => {
  if (!contextLine) {
    return toolContext;
  }

  if (toolContext) {
    return `${toolContext}${contextLine}`;
  }

  return `- Note: The following files are available in the "${Tools.execute_code}" tool environment:${contextLine}`;
};

/**
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Agent['tool_resources']} options.tool_resources
 * @param {string} [options.agentId] - The agent ID for file access control
 * @returns {Promise<{
 * files: Array<{ id: string; session_id: string; name: string }>,
 * toolContext: string,
 * }>}
 */
const primeFiles = async (options) => {
  const { tool_resources, req, agentId } = options;
  const file_ids = tool_resources?.[EToolResources.execute_code]?.file_ids ?? [];
  const agentResourceIds = new Set(file_ids);
  const resourceFiles = tool_resources?.[EToolResources.execute_code]?.files ?? [];

  /* Step 1 of the priming trace: input volume. Pair with the
   * per-file `[primeCodeFiles] file=...` lines and the final
   * `[primeCodeFiles] returned=...` line below to locate which
   * layer drops a file the sandbox doesn't end up seeing. */
  logger.debug(
    `[primeCodeFiles] in: file_ids=${file_ids.length} resourceFiles=${resourceFiles.length}`,
    { agentId, file_ids, resourceFileIds: resourceFiles.map((f) => f?.file_id) },
  );

  // Get all files first
  const allFiles = (await getFiles({ file_id: { $in: file_ids } }, null, { text: 0 })) ?? [];

  // Filter by access if user and agent are provided
  let dbFiles;
  if (req?.user?.id && agentId) {
    dbFiles = await filterFilesByAgentAccess({
      files: allFiles,
      userId: req.user.id,
      role: req.user.role,
      agentId,
    });
  } else {
    dbFiles = allFiles;
  }

  dbFiles = dbFiles.concat(resourceFiles);

  const files = [];
  const sessions = new Map();
  let toolContext = '';

  /* Per-file path counters — emitted at the bottom so a single
   * grep on `[primeCodeFiles]` shows the input volume, the per-file
   * paths taken, and the final dispatch summary in one trace. */
  let skippedNoRef = 0;
  let reuploadFailures = 0;

  for (let i = 0; i < dbFiles.length; i++) {
    const file = dbFiles[i];
    if (!file) {
      continue;
    }

    /**
     * Add a concrete Code API reference to the run seed. Passing the
     * reference explicitly prevents stale identifiers from surviving a
     * durable re-upload.
     */
    const pushFile = (activeRef) => {
      toolContext = appendVisibleCodeFileContext(
        toolContext,
        getVisibleCodeFileContextLine(file, agentResourceIds),
      );
      /* `id` is the storage file_id (drives codeapi's upload-key
       * existence check), `resource_id` is the entity that owns
       * the storage session (drives sessionKey re-derivation). For
       * code-output files this is `kind: 'user'` and `resource_id`
       * is informational (codeapi ignores it for user kind), but
       * we still send it for shape uniformity with shared kinds. */
      files.push({
        id: activeRef.file_id,
        resource_id: activeRef.id,
        storage_session_id: activeRef.storage_session_id,
        name: file.filename,
        kind: activeRef.kind,
        ...(activeRef.kind === 'skill' ? { version: activeRef.version } : {}),
      });
    };

    const uploadDurableFile = async (existingRef) => {
      const kind =
        existingRef?.kind ?? (file.context === FileContext.agents && agentId ? 'agent' : 'user');
      const resourceId = existingRef?.id ?? (kind === 'agent' ? agentId : options.req?.user?.id);
      if (!resourceId) {
        throw new Error('Code file owner identity is unavailable');
      }

      const { getDownloadStream } = getStrategyFunctions(file.source);
      const { handleFileUpload: uploadCodeEnvFile } = getStrategyFunctions(
        FileSources.execute_code,
      );
      const stream = await getDownloadStream(options.req, file.filepath);
      const uploaded = await uploadCodeEnvFile({
        req: options.req,
        stream,
        filename: file.filename,
        kind,
        id: resourceId,
        ...(kind === 'skill' && existingRef?.version != null
          ? { version: existingRef.version }
          : {}),
      });

      const newRef = {
        kind,
        id: resourceId,
        storage_session_id: uploaded.storage_session_id,
        file_id: uploaded.file_id,
        ...(kind === 'skill' && existingRef?.version != null
          ? { version: existingRef.version }
          : {}),
      };
      await updateFile({
        file_id: file.file_id,
        metadata: {
          ...file.metadata,
          codeEnvRef: newRef,
        },
      });
      return newRef;
    };

    const ref = file.metadata?.codeEnvRef;
    if (!ref) {
      skippedNoRef += 1;
      try {
        const newRef = await uploadDurableFile();
        sessions.set(newRef.storage_session_id, true);
        pushFile(newRef);
        logger.debug(
          `[primeCodeFiles] file=${file.file_id} path=hydrate-success ` +
            `newSession=${newRef.storage_session_id} newFileId=${newRef.file_id}`,
        );
      } catch (error) {
        reuploadFailures += 1;
        logger.error(
          `[primeCodeFiles] file=${file.file_id} path=hydrate-failed: ${error.message}`,
          error,
        );
      }
      continue;
    }

    const session_id = ref.storage_session_id;

    if (sessions.has(session_id)) {
      logger.debug(
        `[primeCodeFiles] file=${file.file_id} path=cache-hit-by-session storage_session_id=${session_id}`,
      );
      pushFile(ref);
      continue;
    }

    const reuploadFile = async () => {
      try {
        const newRef = await uploadDurableFile(ref);
        sessions.set(newRef.storage_session_id, true);
        pushFile(newRef);
        logger.debug(
          `[primeCodeFiles] file=${file.file_id} path=reupload-success ` +
            `oldSession=${session_id} newSession=${newRef.storage_session_id} newFileId=${newRef.file_id}`,
        );
      } catch (error) {
        reuploadFailures += 1;
        logger.error(
          `[primeCodeFiles] file=${file.file_id} path=reupload-failed session=${session_id}: ${error.message}`,
          error,
        );
      }
    };
    const uploadTime = await getSessionInfo(ref, req);
    if (!uploadTime) {
      logger.debug(
        `[primeCodeFiles] file=${file.file_id} path=reupload reason=no-uploadtime ` +
          `storage_session_id=${session_id}`,
      );
      await reuploadFile();
      continue;
    }
    if (!checkIfActive(uploadTime)) {
      logger.debug(
        `[primeCodeFiles] file=${file.file_id} path=reupload reason=stale ` +
          `uploadTime=${uploadTime} storage_session_id=${session_id}`,
      );
      await reuploadFile();
      continue;
    }
    sessions.set(session_id, true);
    logger.debug(
      `[primeCodeFiles] file=${file.file_id} path=fresh-active storage_session_id=${session_id}`,
    );
    pushFile(ref);
  }

  /* Dispatch summary — emitted unconditionally so a single grep on
   * `[primeCodeFiles] out` always shows the final state, not only
   * the per-path trail leading up to it. */
  logger.debug(
    `[primeCodeFiles] out: returned=${files.length} ` +
      `skippedNoRef=${skippedNoRef} reuploadFailures=${reuploadFailures}`,
  );

  if (reuploadFailures > 0) {
    throw new Error(
      `Unable to hydrate ${reuploadFailures} code file${reuploadFailures === 1 ? '' : 's'}`,
    );
  }

  return { files, toolContext };
};

/**
 * Reads a single file from the code-execution sandbox by shelling `cat`
 * through the sandbox `/exec` endpoint. Used by the `read_file` host
 * handler when the requested path is a code-env path (`/mnt/data/...`)
 * or otherwise not resolvable as a skill file. Resolves to
 * `{ content }` from stdout on success, or `null` when the codeapi base
 * URL isn't configured / the read returns no content (caller turns that
 * into a model-visible error). Throws axios-style errors on transport
 * failure so the caller can surface a meaningful error message.
 *
 * `session_id` and `files` come from the seeded `tc.codeSessionContext`
 * (emitted by the agents-side `ToolNode` for `read_file` calls in
 * v3.1.72+) so the read lands in the same sandbox session that holds
 * the agent's prior-turn artifacts.
 *
 * @param {Object} params
 * @param {string} params.file_path - Absolute path inside the sandbox (e.g. `/mnt/data/foo.txt`).
 * @param {string} [params.session_id] - Sandbox session id from the seeded context.
 * @param {Array<{id: string, name: string, session_id?: string}>} [params.files] - File refs to mount.
 * @param {ServerRequest} [params.req] - Current authenticated request, used to mint Code API auth.
 * @returns {Promise<{content: string} | null>}
 */
async function readSandboxFile({ file_path, session_id, files, req }) {
  const baseURL = getCodeBaseURL();
  if (!baseURL) {
    return null;
  }

  /** Single-quote `file_path` with embedded-quote escaping so a malicious
   *  filename can't break out of the `cat` command. The handler upstream
   *  has already established this is a code-env path the model
   *  legitimately asked to read; this just keeps the shell quoting safe. */
  const safePath = `'${file_path.replace(/'/g, `'\\''`)}'`;
  /** @type {Record<string, unknown>} */
  const postData = { lang: 'bash', code: `cat ${safePath}` };
  if (session_id) {
    postData.session_id = session_id;
  }
  if (files && files.length > 0) {
    postData.files = files;
  }

  try {
    const authHeaders = await getCodeApiAuthHeaders(req);
    const response = await axios({
      method: 'post',
      url: `${baseURL}/exec`,
      data: postData,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 15000,
    });
    const result = response?.data ?? {};
    if (result.stderr && (result.stdout == null || result.stdout === '')) {
      throw new Error(String(result.stderr).trim());
    }
    if (result.stdout == null) {
      return null;
    }
    return { content: String(result.stdout) };
  } catch (error) {
    logAxiosError({
      message: `Error reading sandbox file "${file_path}"`,
      error,
    });
    throw error;
  }
}

/**
 * Writes a UTF-8 text file into the code-execution sandbox by running a
 * small Python writer through the sandbox `/exec` endpoint. The payload is
 * base64-encoded JSON so neither the file path nor the content is
 * interpolated into shell syntax.
 *
 * @param {Object} params
 * @param {string} params.file_path - Path inside the sandbox (prefer `/mnt/data/...`).
 * @param {string} params.content - Complete UTF-8 text content to write.
 * @param {string} [params.session_id] - Sandbox session id from the seeded context.
 * @param {Array<{id: string, name: string, session_id?: string}>} [params.files] - File refs to mount.
 * @param {ServerRequest} [params.req] - Current authenticated request, used to mint Code API auth.
 * @returns {Promise<{stdout?: string, stderr?: string, session_id?: string, files?: Array<Object>} | null>}
 */
async function writeSandboxFile({ file_path, content, session_id, files, req }) {
  const baseURL = getCodeBaseURL();
  if (!baseURL) {
    return null;
  }

  const payload = Buffer.from(
    JSON.stringify({
      file_path,
      content_b64: Buffer.from(content, 'utf8').toString('base64'),
    }),
    'utf8',
  ).toString('base64');
  const code = [
    "python3 - <<'PY'",
    'import base64, json, os',
    `payload = ${JSON.stringify(payload)}`,
    "data = json.loads(base64.b64decode(payload).decode('utf-8'))",
    "path = data['file_path']",
    "content = base64.b64decode(data['content_b64'])",
    'parent = os.path.dirname(path)',
    'if parent:',
    '    os.makedirs(parent, exist_ok=True)',
    "with open(path, 'wb') as f:",
    '    f.write(content)',
    'print(f"WROTE {len(content)} bytes to {path}")',
    'PY',
  ].join('\n');

  /** @type {Record<string, unknown>} */
  const postData = { lang: 'bash', code };
  if (session_id) {
    postData.session_id = session_id;
  }
  if (files && files.length > 0) {
    postData.files = files;
  }

  try {
    const authHeaders = await getCodeApiAuthHeaders(req);
    const response = await axios({
      method: 'post',
      url: `${baseURL}/exec`,
      data: postData,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 15000,
    });
    const result = response?.data ?? {};
    if (result.stderr && (result.stdout == null || result.stdout === '')) {
      throw new Error(String(result.stderr).trim());
    }
    if (result.stdout == null && result.session_id == null) {
      return null;
    }
    return {
      stdout: result.stdout == null ? undefined : String(result.stdout),
      stderr: result.stderr == null ? undefined : String(result.stderr),
      session_id: result.session_id,
      files: result.files,
    };
  } catch (error) {
    logAxiosError({
      message: `Error writing sandbox file "${file_path}"`,
      error,
    });
    throw error;
  }
}

module.exports = {
  primeFiles,
  checkIfActive,
  getSessionInfo,
  processCodeOutput,
  readSandboxFile,
  writeSandboxFile,
};
