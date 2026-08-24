const { Tools } = require('librechat-data-provider');

// Mock all dependencies before requiring the module
jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'mock-id'),
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  HOST_FILE_AUTHORING_ARTIFACT_KEY: '__librechat_file_authoring',
  isCodeSessionToolName: jest.fn((name) =>
    ['execute_code', 'bash_tool', 'read_file'].includes(name),
  ),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  getMessageId: jest.fn(),
  ToolEndHandler: jest.fn(),
  handleToolCalls: jest.fn(),
}));

jest.mock('~/server/services/Files/Citations', () => ({
  processFileCitations: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  saveBase64Image: jest.fn(),
}));

describe('createToolEndCallback', () => {
  let req, res, artifactPromises, createToolEndCallback;
  let logger;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get the mocked logger
    logger = require('@librechat/data-schemas').logger;

    // Now require the module after all mocks are set up
    const callbacks = require('../callbacks');
    createToolEndCallback = callbacks.createToolEndCallback;

    req = {
      user: { id: 'user123' },
    };
    res = {
      headersSent: false,
      write: jest.fn(),
    };
    artifactPromises = [];
  });

  describe('ui_resources artifact handling', () => {
    it('should process ui_resources artifact and return attachment when headers not sent', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [
              { type: 'button', label: 'Click me' },
              { type: 'input', placeholder: 'Enter text' },
            ],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);

      // Wait for all promises to resolve
      const results = await Promise.all(artifactPromises);

      // When headers are not sent, it returns attachment without writing
      expect(res.write).not.toHaveBeenCalled();

      const attachment = results[0];
      expect(attachment).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [
          { type: 'button', label: 'Click me' },
          { type: 'input', placeholder: 'Enter text' },
        ],
      });
    });

    it('should write to response when headers are already sent', async () => {
      res.headersSent = true;
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'carousel', items: [] }],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(res.write).toHaveBeenCalled();
      expect(results[0]).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [{ type: 'carousel', items: [] }],
      });
    });

    it('should handle errors when processing ui_resources', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      // Mock res.write to throw an error
      res.headersSent = true;
      res.write.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'test' }],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(logger.error).toHaveBeenCalledWith(
        'Error processing artifact content:',
        expect.any(Error),
      );
      expect(results[0]).toBeNull();
    });

    it('should handle multiple artifacts including ui_resources', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'chart', data: [] }],
          },
          [Tools.web_search]: {
            results: ['result1', 'result2'],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      // Both ui_resources and web_search should be processed
      expect(artifactPromises).toHaveLength(2);
      expect(results).toHaveLength(2);

      // Check ui_resources attachment
      const uiResourceAttachment = results.find((r) => r?.type === Tools.ui_resources);
      expect(uiResourceAttachment).toBeTruthy();
      expect(uiResourceAttachment[Tools.ui_resources]).toEqual([{ type: 'chart', data: [] }]);

      // Check web_search attachment
      const webSearchAttachment = results.find((r) => r?.type === Tools.web_search);
      expect(webSearchAttachment).toBeTruthy();
      expect(webSearchAttachment[Tools.web_search]).toEqual({
        results: ['result1', 'result2'],
      });
    });

    it('should not process artifacts when output has no artifacts', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        content: 'Some regular content',
        // No artifact property
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle empty ui_resources data object', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(results[0]).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [],
      });
    });

    it('should handle ui_resources with complex nested data', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const complexData = {
        0: {
          type: 'form',
          fields: [
            { name: 'field1', type: 'text', required: true },
            { name: 'field2', type: 'select', options: ['a', 'b', 'c'] },
          ],
          nested: {
            deep: {
              value: 123,
              array: [1, 2, 3],
            },
          },
        },
      };

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: complexData,
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(results[0][Tools.ui_resources]).toEqual(complexData);
    });

    it('should handle when output is undefined', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output: undefined }, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });

    it('should handle when data parameter is undefined', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback(undefined, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('code execution attachment emit', () => {
    const { processCodeOutput } = require('~/server/services/Files/Code/process');

    function makeCodeExecutionEvent({
      runId,
      threadId,
      toolCallId,
      fileId,
      name,
      toolName = 'execute_code',
      hostFileAuthoring = false,
    }) {
      return {
        output: {
          name: toolName,
          tool_call_id: toolCallId,
          artifact: {
            ...(hostFileAuthoring ? { __librechat_file_authoring: true } : {}),
            session_id: 'sess-1',
            files: [{ id: fileId, name, session_id: 'sess-1' }],
          },
        },
        metadata: { run_id: runId, thread_id: threadId },
      };
    }

    /** Parse the SSE frame `res.write` produces back to a payload object. */
    function parseSseAttachment(call) {
      const frame = call[0];
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(dataLine.slice('data: '.length));
    }

    it('emits a download-only Office attachment once without preview lifecycle metadata', async () => {
      res.headersSent = true;
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-office',
          filename: 'deck.pptx',
          filepath: '/uploads/deck.pptx',
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          messageId: 'run-1',
          toolCallId: 'tool-1',
          status: null,
          text: null,
          textFormat: null,
        },
      });

      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-1',
        threadId: 'thread-1',
        toolCallId: 'tool-1',
        fileId: 'fid-office',
        name: 'deck.pptx',
      });
      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);

      expect(res.write).toHaveBeenCalledTimes(1);
      expect(parseSseAttachment(res.write.mock.calls[0])).toEqual(
        expect.objectContaining({
          file_id: 'fid-office',
          filename: 'deck.pptx',
          status: null,
          text: null,
          textFormat: null,
        }),
      );
    });

    it('processes create_file sandbox artifacts like code execution outputs', async () => {
      res.headersSent = true;
      processCodeOutput.mockResolvedValue({
        file: {
          file_id: 'fid-created',
          filename: 'created.txt',
          filepath: '/uploads/created.txt',
          type: 'text/plain',
          conversationId: 'thread789',
          messageId: 'run-create',
          toolCallId: 'tool-create',
          status: null,
        },
      });

      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-create',
        threadId: 'thread789',
        toolCallId: 'tool-create',
        fileId: 'fid-created',
        name: 'created.txt',
        toolName: 'create_file',
        hostFileAuthoring: true,
      });
      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);

      expect(processCodeOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'fid-created',
          name: 'created.txt',
          messageId: 'run-create',
          toolCallId: 'tool-create',
          conversationId: 'thread789',
        }),
      );
      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it('does not process arbitrary user tool artifacts named create_file as code outputs', async () => {
      res.headersSent = true;
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
      const event = makeCodeExecutionEvent({
        runId: 'run-user-create',
        threadId: 'thread789',
        toolCallId: 'tool-user-create',
        fileId: 'fid-user-created',
        name: 'created.txt',
        toolName: 'create_file',
      });

      await toolEndCallback({ output: event.output }, event.metadata);
      await Promise.all(artifactPromises);

      expect(processCodeOutput).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
    });
  });
});

describe('isStreamWritable', () => {
  /* Direct parametric coverage of the predicate that gates SSE writes
   * in both the chat-completions and Open Responses callbacks. The
   * tests pin down each individual branch so a future modification
   * (e.g. adding a new condition) can't silently regress.
   */
  const { isStreamWritable } = require('../callbacks');

  it('returns true when streamId is truthy regardless of res state', () => {
    /* Resumable mode writes go to the job emitter; res state is
     * irrelevant. Even a closed res with no headers should not block. */
    expect(isStreamWritable(null, 'stream-1')).toBe(true);
    expect(isStreamWritable({ headersSent: false, writableEnded: true }, 'stream-1')).toBe(true);
    expect(isStreamWritable(undefined, 'stream-1')).toBe(true);
  });

  it('returns false when streamId is falsy and res is null/undefined', () => {
    expect(isStreamWritable(null, null)).toBe(false);
    expect(isStreamWritable(undefined, null)).toBe(false);
  });

  it('returns false when headers have not been sent yet', () => {
    expect(isStreamWritable({ headersSent: false, writableEnded: false }, null)).toBe(false);
  });

  it('returns false when the stream has already ended', () => {
    expect(isStreamWritable({ headersSent: true, writableEnded: true }, null)).toBe(false);
  });

  it('returns true on the happy path: headers sent, not ended, no streamId', () => {
    expect(isStreamWritable({ headersSent: true, writableEnded: false }, null)).toBe(true);
  });
});
