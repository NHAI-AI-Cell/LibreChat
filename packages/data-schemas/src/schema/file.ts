import mongoose, { Schema } from 'mongoose';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '~/types';

const file: Schema<IMongoFile> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    messageId: {
      type: String,
      index: true,
    },
    file_id: {
      type: String,
      index: true,
      required: true,
    },
    temp_file_id: {
      type: String,
    },
    bytes: {
      type: Number,
      required: true,
    },
    filename: {
      type: String,
      required: true,
    },
    filepath: {
      type: String,
      required: true,
    },
    storageKey: {
      type: String,
    },
    storageRegion: {
      type: String,
    },
    object: {
      type: String,
      required: true,
      default: 'file',
    },
    embedded: {
      type: Boolean,
    },
    type: {
      type: String,
      required: true,
    },
    text: {
      type: String,
    },
    textFormat: {
      /* 'text' for current extracts; 'html' remains readable for older
       * trusted-preview records written before Office became download-only. */
      type: String,
      enum: ['html', 'text'],
    },
    status: {
      /* Legacy Office-preview field retained for existing records. */
      type: String,
      enum: ['pending', 'ready', 'failed'],
      index: true,
    },
    previewError: {
      type: String,
      /* Keep old machine-readable failure values bounded. */
      maxlength: 200,
    },
    previewRevision: {
      /* Legacy Office-preview generation marker. */
      type: String,
    },
    context: {
      type: String,
    },
    usage: {
      type: Number,
      required: true,
      default: 0,
    },
    source: {
      type: String,
      default: FileSources.local,
    },
    model: {
      type: String,
    },
    width: Number,
    height: Number,
    metadata: {
      codeEnvRef: {
        type: new Schema(
          {
            kind: {
              type: String,
              enum: ['skill', 'agent', 'user'],
              required: true,
            },
            id: { type: String, required: true },
            storage_session_id: { type: String, required: true },
            file_id: { type: String, required: true },
            version: { type: Number },
          },
          { _id: false },
        ),
        default: undefined,
      },
    },
    expiresAt: {
      /* Short-lived upload TTL managed by MongoDB. This is separate from
       * retention-scoped `expiredAt`, which is swept by application code
       * after storage cleanup succeeds. */
      type: Date,
      expires: 3600, // 1 hour in seconds
    },
    tenantId: {
      type: String,
      index: true,
    },
    expiredAt: {
      /* Retention deadline for persisted files. The file sweep deletes the
       * backing storage first, then removes this metadata record. */
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

file.index({ expiredAt: 1 });
file.index({ createdAt: 1, updatedAt: 1 });
file.index(
  { filename: 1, conversationId: 1, context: 1, tenantId: 1 },
  { unique: true, partialFilterExpression: { context: FileContext.execute_code } },
);

export default file;
