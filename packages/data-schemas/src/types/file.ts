import { Document, Types } from 'mongoose';
import type { CodeEnvRef } from 'librechat-data-provider';

export interface IMongoFile extends Omit<Document, 'model'> {
  user: Types.ObjectId;
  conversationId?: string;
  messageId?: string;
  file_id: string;
  temp_file_id?: string;
  bytes: number;
  text?: string;
  /**
   * Format of the `text` field. `'html'` remains valid for older trusted
   * markup records; new generated Office files are download-only.
   */
  textFormat?: 'html' | 'text';
  /**
   * Legacy Office-preview lifecycle field retained for schema compatibility.
   */
  status?: 'pending' | 'ready' | 'failed';
  /**
   * Legacy Office-preview failure field.
   */
  previewError?: string;
  /**
   * Legacy Office-preview generation marker.
   */
  previewRevision?: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  object: 'file';
  embedded?: boolean;
  type: string;
  context?: string;
  usage: number;
  source: string;
  model?: string;
  width?: number;
  height?: number;
  metadata?: {
    /**
     * Code-environment cache pointer for files re-uploadable to
     * codeapi (chat attachments, agent tool resources, code-output
     * files). Carries the resource kind + identity so codeapi can
     * derive the sessionKey explicitly.
     */
    codeEnvRef?: CodeEnvRef;
  };
  expiresAt?: Date;
  expiredAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}
