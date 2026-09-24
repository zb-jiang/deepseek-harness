package com.dsh.console.knowledge.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 知识库(一个应用一个库,setup guide §12 {@code knowledge_bases} 表)。
 *
 * @param id            知识库 id
 * @param applicationId 所属应用
 * @param name          名称(默认「{应用名} 知识库」)
 * @param storageBucket Supabase Storage 桶名(公共桶 'kb-documents',对象路径 {appId}/ 段隔离)
 * @param createdAt     创建时间
 */
public record KnowledgeBaseDto(
    UUID id,
    UUID applicationId,
    String name,
    String storageBucket,
    OffsetDateTime createdAt
) {
}
