/**
 * Web-console 知识库 API 客户端(企业员工端,design 2026-09-11 §6)。
 *
 * <p>全部端点经本地 DSH webserver 的 {@code /api/enterprise/kb} 前缀代理到
 * web-console 的 {@code /api/kb};请求带企业 JWT(与 task-api 同源同 token)。
 * 响应是 web-console 的 {@code ApiResponse} 包装,非 2xx 或 success=false 抛
 * {@link KbApiError}(404 在 {@link getKbByApp} 中特例为 null = 应用未开通)。
 */
import { readToken } from './task-api.ts'

/** web-console 统一响应包装({@code ApiResponse<T>})。 */
type ApiResponse<T> = {
  success: boolean
  data: T | null
  error: { code: string; message: string } | null
}

/** 知识库(一个应用一个库,KnowledgeBaseDto)。 */
export type KnowledgeBase = {
  id: string
  applicationId: string
  name: string
  storageBucket: string
  createdAt: string
}

/** 当前用户可见的知识库清单项(/api/kb/mine,KbAppSummaryDto)。 */
export type KbAppSummary = {
  kbId: string
  applicationId: string
  applicationName: string
  kbName: string
}

/** 知识库文件夹(KbFolderDto;path 为物化路径,如 /财务/报销)。 */
export type KbFolder = {
  id: string
  kbId: string
  parentId: string | null
  name: string
  path: string
  createdAt: string
}

/** 文档解析状态:pending 待解析 / ready 可检索 / failed 解析失败。 */
export type KbParseStatus = 'pending' | 'ready' | 'failed'

/** 知识库文档列表项(KbDocumentDto;不含原文,仅 textExcerpt 摘要窗口)。 */
export type KbDocument = {
  id: string
  kbId: string
  folderId: string | null
  name: string
  contentType: string
  sizeBytes: number
  parseStatus: KbParseStatus
  parseError: string | null
  textExcerpt: string
  uploadedBy: string
  uploaderName: string | null
  createdAt: string
  updatedAt: string
}

/** KB API 请求失败;status 保留 HTTP 状态码(404 = 应用未开通知识库)。 */
export class KbApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'KbApiError'
  }
}

/** 本地代理前缀(webserver 路由 /api/enterprise/kb → web-console /api/kb)。 */
const KB_BASE = '/api/enterprise/kb'

/**
 * 解包 ApiResponse 载荷;非 2xx 或 success=false 抛 {@link KbApiError}。
 * @param res - 已结算的 fetch 响应。
 * @param path - 请求路径(错误消息定位)。
 * @returns 包装内的 data。
 */
async function unwrap<T>(res: Response, path: string): Promise<T> {
  let body: ApiResponse<T> | null = null
  try {
    body = await res.json() as ApiResponse<T>
  } catch {
    // 载荷不是 JSON(网关错误页等)时按空错误体处理,走统一抛错路径。
  }
  if (!res.ok) {
    throw new KbApiError(res.status, body?.error?.message ?? `${res.status} ${res.statusText}: ${path}`)
  }
  if (body === null || !body.success || body.data === null) {
    throw new KbApiError(res.status, body?.error?.message ?? `知识库请求失败: ${path}`)
  }
  return body.data
}

/**
 * 带企业 JWT 的 JSON 请求并解包。
 * @param path - KB_BASE 之后的路径(含前导 /)。
 * @param init - 透传 fetch init。
 */
async function kbFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return unwrap<T>(await fetch(`${KB_BASE}${path}`, { ...init, headers }), path)
}

/**
 * 按应用查知识库(成员可读,不开通;待办定位知识库的入口)。
 * @param appId - 流程定义所属应用 id(Task.applicationId)。
 * @returns 知识库;应用未开通(404)为 null,调用方隐藏知识库入口。
 * @throws 网络/鉴权等其他失败(调用方走错误提示)。
 */
export async function getKbByApp(appId: string): Promise<KnowledgeBase | null> {
  try {
    return await kbFetch<KnowledgeBase>(`/by-app/${appId}`)
  } catch (e) {
    if (e instanceof KbApiError && e.status === 404) return null
    throw e
  }
}

/** 当前用户可见的知识库清单(应用管理员 ∪ active 成员;工作空间上传选应用)。 */
export async function listMyKbs(): Promise<KbAppSummary[]> {
  return kbFetch<KbAppSummary[]>('/mine')
}

/** 知识库的文件夹全集(平铺按 path 排序,前端组树)。 */
export async function listFolders(kbId: string): Promise<KbFolder[]> {
  return kbFetch<KbFolder[]>(`/${kbId}/folders`)
}

/**
 * 按文档 id 查文档元数据(历史消息 docid 徽标反查名称)。
 * @param docId - 文档 id(服务端 UUID)。
 * @throws KbApiError 文档不存在(404,如已删除)或员工失去应用访问权。
 */
export async function getDocument(docId: string): Promise<KbDocument> {
  return kbFetch<KbDocument>(`/documents/${docId}`)
}

/** 文档列表查询参数。 */
export interface ListDocumentsQuery {
  /** 目标文件夹;null = 根。 */
  folderId?: string | null
  /** 含子树(文件夹树整树展示用)。 */
  recursive?: boolean
  /** 关键字检索(仅返回解析 ready 的文档)。 */
  kw?: string
}

/** 列文档(按文件夹/关键字;搜索结果按解析就绪过滤)。 */
export async function listDocuments(kbId: string, query: ListDocumentsQuery = {}): Promise<KbDocument[]> {
  const params = new URLSearchParams()
  if (query.folderId != null) params.set('folderId', query.folderId)
  if (query.recursive === true) params.set('recursive', 'true')
  if (query.kw != null && query.kw !== '') params.set('kw', query.kw)
  const qs = params.size === 0 ? '' : `?${params.toString()}`
  return kbFetch<KbDocument[]>(`/${kbId}/documents${qs}`)
}

/**
 * 上传文档到知识库(multipart;响应为 pending,解析异步进行)。
 * @param kbId - 目标知识库。
 * @param file - 工作空间读出的文件内容。
 * @param folderId - 目标文件夹;null = 根。
 * @returns 上传后的文档元数据(parseStatus=pending)。
 */
export async function uploadDocument(kbId: string, file: File, folderId: string | null = null): Promise<KbDocument> {
  const token = readToken()
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  const form = new FormData()
  form.append('file', file)
  const query = folderId !== null ? `?folderId=${encodeURIComponent(folderId)}` : ''
  const res = await fetch(`${KB_BASE}/${kbId}/documents${query}`, { method: 'POST', headers, body: form })
  return unwrap<KbDocument>(res, `/${kbId}/documents`)
}
