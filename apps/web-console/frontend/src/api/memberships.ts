import { del, get, post } from './client'

export interface AppMembershipDto {
  id: string
  appId: string
  userId: string
  roleIds: string[]
  status: string
  grantedAt: string | null
  grantedBy: string | null
}

export interface UpsertMembershipRequest {
  userId: string
  roleIds: string[]
}

export const membershipsApi = {
  listByApp: (appId: string) =>
    get<AppMembershipDto[]>(`/api/applications/${appId}/memberships`),
  get: (appId: string, membershipId: string) =>
    get<AppMembershipDto>(`/api/applications/${appId}/memberships/${membershipId}`),
  upsert: (appId: string, body: UpsertMembershipRequest) =>
    post<AppMembershipDto>(`/api/applications/${appId}/memberships`, body),
  disable: (appId: string, membershipId: string) =>
    del<AppMembershipDto>(`/api/applications/${appId}/memberships/${membershipId}`),
  activate: (appId: string, membershipId: string) =>
    post<AppMembershipDto>(`/api/applications/${appId}/memberships/${membershipId}/activate`),
}
