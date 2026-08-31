import axios, { type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { supabase } from '../lib/supabase'
import type { ApiError, ApiResponse } from './types'

const baseURL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

/**
 * Web Console 后端 axios 客户端。
 *
 * <p>request 拦截器:从 Supabase session 拿 access_token 加 Authorization: Bearer。
 * <p>response 拦截器:解包 ApiResponse(success → data;fail → 抛 Error 含 code/message)。
 *
 * V1 dev 时 baseURL 为空,通过 Vite proxy /api → http://localhost:8080;
 * 生产环境 VITE_API_BASE_URL 填后端实际地址。
 */
export const http = axios.create({
  baseURL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
})

http.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

http.interceptors.response.use(
  (resp: AxiosResponse<ApiResponse<unknown>>) => {
    const body = resp.data
    if (body && typeof body === 'object' && 'success' in body) {
      if (body.success) {
        // 把 ApiResponse<T> 解包成裸 T 直接返回,调用方拿到的就是 data 字段
        return body.data as unknown as AxiosResponse
      }
      const err: ApiError | null = body.error
      const e = new Error(err?.message ?? '请求失败')
      ;(e as Error & { code?: string; details?: string[] }).code = err?.code
      ;(e as Error & { details?: string[] }).details = err?.details
      return Promise.reject(e)
    }
    // 非标准 ApiResponse(如 Flowable 透传响应)直接返回
    return resp as unknown as AxiosResponse
  },
  (err: AxiosError<ApiResponse<unknown>>) => {
    if (err.response?.status === 401) {
      // session 失效,清空并跳登录。跳转放在调用方处理,这里只 reject
      void supabase.auth.signOut()
    }
    const body = err.response?.data
    if (body && typeof body === 'object' && 'success' in body && !body.success) {
      const apiErr: ApiError | null = body.error
      const e = new Error(apiErr?.message ?? err.message)
      ;(e as Error & { code?: string; details?: string[] }).code = apiErr?.code
      ;(e as Error & { details?: string[] }).details = apiErr?.details
      ;(e as Error & { status?: number }).status = err.response?.status
      return Promise.reject(e)
    }
    ;(err as Error & { status?: number }).status = err.response?.status
    return Promise.reject(err)
  },
)

/**
 * 类型化 GET 包装:成功时直接返回 data 字段(T)。
 */
export async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const resp = await http.get<ApiResponse<T>>(url, { params })
  return resp as unknown as T
}

/**
 * 类型化 POST 包装。
 */
export async function post<T>(url: string, body?: unknown): Promise<T> {
  const resp = await http.post<ApiResponse<T>>(url, body)
  return resp as unknown as T
}

/**
 * 类型化 PATCH 包装。
 */
export async function patch<T>(url: string, body?: unknown): Promise<T> {
  const resp = await http.patch<ApiResponse<T>>(url, body)
  return resp as unknown as T
}

/**
 * 类型化 DELETE 包装(后端 delete 返回 ApiResponse<T>)。
 */
export async function del<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const resp = await http.delete<ApiResponse<T>>(url, { params })
  return resp as unknown as T
}
