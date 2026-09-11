package com.dsh.console.knowledge.dto;

import java.util.UUID;

/**
 * 文档原文下载结果(Controller 据此设置响应头与流式载荷)。
 *
 * @param docId       文档 id
 * @param name        文档名(Content-Disposition 用)
 * @param contentType MIME 类型
 * @param content     文件字节
 */
public record KbDocumentContentDto(
    UUID docId,
    String name,
    String contentType,
    byte[] content
) {
}
