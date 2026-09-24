package com.expense.sor.service;

import com.expense.sor.config.AppProperties;
import com.expense.sor.exception.BadRequestException;
import com.expense.sor.exception.NotFoundException;
import com.expense.sor.repo.ExpenseRepository;
import com.expense.sor.repo.ExpenseRepository.AttachmentRow;
import com.expense.sor.web.dto.AttachmentMetaDto;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * 附件存储(设计文档 §7.2):
 * - 先独立上传(不属于任何单据),建单时通过 attachmentIds 关联
 * - 文件落盘到配置目录,命名 {generatedUUID}-{原始文件名}
 * - 单个 ≤ 10MB;类型仅 pdf/png/jpeg
 */
@Service
public class AttachmentService {

    private static final long MAX_SIZE_BYTES = 10L * 1024 * 1024;
    private static final Set<String> ALLOWED_EXTENSIONS = Set.of("pdf", "png", "jpg", "jpeg");
    private static final Set<String> ALLOWED_CONTENT_TYPES =
            Set.of("application/pdf", "image/png", "image/jpeg");

    private final AppProperties props;
    private final ExpenseRepository repo;

    public AttachmentService(AppProperties props, ExpenseRepository repo) {
        this.props = props;
        this.repo = repo;
    }

    public AttachmentMetaDto upload(MultipartFile file, String uploadedBy) {
        if (file == null || file.isEmpty()) {
            throw new BadRequestException("上传文件不能为空");
        }
        if (file.getSize() > MAX_SIZE_BYTES) {
            throw new BadRequestException("上传文件超过 10MB 限制");
        }
        String originalName = sanitizeFileName(file.getOriginalFilename());
        String extension = extensionOf(originalName);
        if (!ALLOWED_EXTENSIONS.contains(extension)) {
            throw new BadRequestException("附件类型仅支持 pdf/png/jpeg");
        }
        String contentType = file.getContentType();
        if (contentType == null || contentType.isBlank()
                || "application/octet-stream".equalsIgnoreCase(contentType)) {
            contentType = contentTypeFor(extension);
        } else if (!ALLOWED_CONTENT_TYPES.contains(contentType.toLowerCase(Locale.ROOT))) {
            throw new BadRequestException("附件类型仅支持 pdf/png/jpeg");
        }

        UUID id = UUID.randomUUID();
        String storagePath = id + "-" + originalName;
        Path dir = Path.of(props.attachmentDir());
        Path target = resolveSafely(dir, storagePath);

        try {
            Files.createDirectories(dir);
            file.transferTo(target.toFile());
        } catch (IOException e) {
            throw new BadRequestException("附件保存失败: " + e.getMessage());
        }

        try {
            AttachmentRow row = repo.insertAttachment(null, originalName, contentType, file.getSize(),
                    storagePath, uploadedBy == null ? "unknown" : uploadedBy);
            return toMeta(row);
        } catch (RuntimeException e) {
            // 元数据入库失败,清理已落盘文件,避免孤儿文件
            try {
                Files.deleteIfExists(target);
            } catch (IOException ignore) {
                // ignore
            }
            throw e;
        }
    }

    /** 读取附件本体(校验归属单据),返回元数据与磁盘路径 */
    public record AttachmentFile(AttachmentRow row, Path path) {
    }

    public AttachmentFile loadForDownload(UUID reportId, UUID attachmentId) {
        AttachmentRow row = repo.findAttachmentById(attachmentId)
                .orElseThrow(() -> new NotFoundException("附件"));
        if (row.reportId() == null || !row.reportId().equals(reportId)) {
            throw new NotFoundException("附件");
        }
        Path path = resolveSafely(Path.of(props.attachmentDir()), row.storagePath());
        if (!Files.isReadable(path)) {
            throw new NotFoundException("附件文件");
        }
        return new AttachmentFile(row, path);
    }

    public AttachmentMetaDto toMeta(AttachmentRow row) {
        return new AttachmentMetaDto(row.id().toString(), row.fileName(), row.contentType(),
                row.sizeBytes(), row.uploadedBy(), row.createdAt());
    }

    // ==================== 内部工具 ====================

    /** 去除路径成分,防目录穿越 */
    private String sanitizeFileName(String name) {
        if (name == null || name.isBlank()) {
            throw new BadRequestException("文件名不能为空");
        }
        String clean = Path.of(name.replace("\\", "/")).getFileName().toString().trim();
        if (clean.isBlank() || ".".equals(clean) || "..".equals(clean)) {
            throw new BadRequestException("文件名非法");
        }
        return clean;
    }

    private String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return "";
        }
        return name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private String contentTypeFor(String extension) {
        return switch (extension) {
            case "pdf" -> "application/pdf";
            case "png" -> "image/png";
            default -> "image/jpeg";
        };
    }

    /** 确保最终路径不逃出附件根目录 */
    private Path resolveSafely(Path root, String relativeName) {
        Path resolved = root.resolve(relativeName).normalize().toAbsolutePath();
        Path rootAbs = root.normalize().toAbsolutePath();
        if (!resolved.startsWith(rootAbs)) {
            throw new BadRequestException("存储路径非法");
        }
        return resolved;
    }
}
