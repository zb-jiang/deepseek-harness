package com.expense.sor.web.dto;

import java.time.OffsetDateTime;

/** 附件元数据(文件本体存磁盘,见设计文档 §5) */
public record AttachmentMetaDto(
        String id,
        String fileName,
        String contentType,
        long sizeBytes,
        String uploadedBy,
        OffsetDateTime createdAt) {
}
