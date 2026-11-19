/**
 * 附件读取、保存与文件选择框 IPC 通道常量
 */
export const ATTACHMENT_IPC_CHANNELS = {
  /** 读取附件（返回 base64） */
  READ_ATTACHMENT: 'attachment:read',
  /** 另存图片到用户选择的位置（原生 Save As 对话框） */
  SAVE_IMAGE_AS: 'attachment:save-image-as',
  /** 保存应用内置资源文件到用户选择的位置（原生 Save As 对话框） */
  SAVE_RESOURCE_FILE_AS: 'attachment:save-resource-file-as',
  /** 打开文件选择对话框 */
  OPEN_FILE_DIALOG: 'attachment:open-file-dialog',
} as const
