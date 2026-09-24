package com.expense.sor.web;

import com.expense.sor.service.AttachmentService;
import com.expense.sor.web.dto.AttachmentMetaDto;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * 附件上传(设计文档 §7.2,仅 JWT):
 * POST /api/expenses/attachments (multipart/form-data, 字段 file)
 */
@RestController
@RequestMapping("/api/expenses/attachments")
public class AttachmentController {

    private final AttachmentService service;

    public AttachmentController(AttachmentService service) {
        this.service = service;
    }

    @PostMapping
    public AttachmentMetaDto upload(@RequestPart("file") MultipartFile file) {
        return service.upload(file, CurrentUser.userId());
    }
}
