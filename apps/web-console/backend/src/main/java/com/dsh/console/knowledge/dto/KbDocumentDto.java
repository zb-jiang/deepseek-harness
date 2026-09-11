package com.dsh.console.knowledge.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 知识库文档列表项({@code kb_documents} 表;不含 storage_path 与全文)。
 *
 * <p>全文 {@code text_content} 不进列表载荷,只给 {@code textExcerpt} 摘要窗口
 * (检索命中时为命中窗口,否则为前 200 字符);原文经下载端点获取。
 *
 * @param id          文档 id
 * @param kbId        所属知识库
 * @param folderId    所在文件夹(null = 根)
 * @param name        文档名(同层唯一)
 * @param contentType 上传时的 MIME 类型
 * @param sizeBytes   文件大小
 * @param parseStatus 解析状态:pending / ready / failed
 * @param parseError  解析失败原因(仅 failed 时非空)
 * @param textExcerpt 抽取文本摘要(见上;ready 且无文本时为空)
 * @param uploadedBy   上传者(Supabase Auth user.id,即 JWT sub)
 * @param uploaderName 上传者显示名(platform_users.display_name;用户记录缺失时为 null)
 * @param createdAt    上传时间
 * @param updatedAt    最近更新时间(解析完成会刷新)
 */
public record KbDocumentDto(
    UUID id,
    UUID kbId,
    UUID folderId,
    String name,
    String contentType,
    long sizeBytes,
    String parseStatus,
    String parseError,
    String textExcerpt,
    String uploadedBy,
    String uploaderName,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt
) {
    /** 解析状态:待解析。 */
    public static final String STATUS_PENDING = "pending";
    /** 解析状态:已就绪(可检索)。 */
    public static final String STATUS_READY = "ready";
    /** 解析状态:解析失败。 */
    public static final String STATUS_FAILED = "failed";
}
