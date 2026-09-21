import type { AxiosResponse } from 'axios'
import { supabase } from '../lib/supabase'
import { http } from './client'
import { del, get, patch, post } from './client'
import type { ApiResponse } from './types'

const baseURL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

/** 知识库(一个应用一个库)。 */
export interface KnowledgeBaseDto {
  id: string
  applicationId: string
  name: string
  storageBucket: string
  createdAt: string | null
}

/** 文件夹(parentId 为 null 表示根目录;path 为物化路径,如 '/财务/报销')。 */
export interface KbFolderDto {
  id: string
  kbId: string
  parentId: string | null
  name: string
  path: string
  createdAt: string | null
}

/** 文档列表项(textExcerpt 为摘要窗口;全文经下载端点获取)。 */
export interface KbDocumentDto {
  id: string
  kbId: string
  folderId: string | null
  name: string
  contentType: string
  sizeBytes: number
  parseStatus: 'pending' | 'ready' | 'failed'
  parseError: string | null
  textExcerpt: string
  uploadedBy: string
  /** 上传者显示名(用户记录缺失时为 null,降级显示 uploadedBy 短 id)。 */
  uploaderName: string | null
  createdAt: string | null
  updatedAt: string | null
}

export const kbApi = {
  /** 查应用知识库(不存在则按需开通)。 */
  ensureByApp: (appId: string) => get<KnowledgeBaseDto>(`/api/apps/${appId}/kb`),

  /** 文件夹平铺列表(后端按 path 排序,前端组树)。 */
  listFolders: (kbId: string) => get<KbFolderDto[]>(`/api/kb/${kbId}/folders`),

  createFolder: (kbId: string, body: { name: string; parentId?: string }) =>
    post<KbFolderDto>(`/api/kb/${kbId}/folders`, body),

  /** 重命名/移动文件夹(后端同步重算子树 path;不支持移动到根)。 */
  updateFolder: (kbId: string, folderId: string, body: { name?: string; parentId?: string }) =>
    patch<KbFolderDto>(`/api/kb/${kbId}/folders/${folderId}`, body),

  deleteFolder: (kbId: string, folderId: string) =>
    del<void>(`/api/kb/${kbId}/folders/${folderId}`),

  /** 列文档。folderId 缺省 = 根;kw 检索时后端只返回解析 ready 的文档。 */
  listDocuments: (
    kbId: string,
    params: { folderId?: string; recursive?: boolean; kw?: string; parseStatus?: string },
  ) => get<KbDocumentDto[]>(`/api/kb/${kbId}/documents`, params as Record<string, unknown>),

  /**
   * 上传文档(multipart)。
   *
   * <p>不走 axios:http 实例默认 JSON Content-Type,而 FormData 必须由浏览器生成
   * 带 boundary 的 multipart 头,故直接用 fetch(不手动设 Content-Type);
   * 顺带避免大文件上传被 axios 30s 超时截断。
   */
  upload: async (kbId: string, file: File, folderId: string | null): Promise<KbDocumentDto> => {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) throw new Error('登录状态失效,请重新登录')
    const form = new FormData()
    form.append('file', file)
    const qs = folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''
    const resp = await fetch(`${baseURL}/api/kb/${kbId}/documents${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const body = (await resp.json()) as ApiResponse<KbDocumentDto>
    if (!resp.ok || !body.success) {
      throw new Error(body.error?.message ?? `上传失败(${resp.status})`)
    }
    if (body.data === null || body.data === undefined) {
      throw new Error('上传响应缺少文档数据')
    }
    return body.data
  },

  /** 下载原文(二进制响应,不经 ApiResponse 解包;拦截器对非标准响应原样放行)。 */
  download: async (kbId: string, docId: string): Promise<Blob> => {
    const resp = await http.get(`/api/kb/${kbId}/documents/${docId}/content`, {
      responseType: 'blob',
    })
    return (resp as unknown as AxiosResponse<Blob>).data
  },

  deleteDocument: (kbId: string, docId: string) =>
    del<void>(`/api/kb/${kbId}/documents/${docId}`),
}
