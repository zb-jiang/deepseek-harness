package com.dsh.console.knowledge;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.knowledge.dto.CreateFolderRequest;
import com.dsh.console.knowledge.dto.KbDocumentContentDto;
import com.dsh.console.knowledge.dto.KbDocumentDto;
import com.dsh.console.knowledge.dto.KbFolderDto;
import com.dsh.console.knowledge.dto.KnowledgeBaseDto;
import com.dsh.console.knowledge.dto.UpdateFolderRequest;
import com.dsh.console.security.AuthContext;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * 知识库 REST 端点(设计文档 §5)。
 *
 * <p>鉴权:JWT 认证后由 {@link KnowledgeService} 做应用成员校验(全员平等读写,
 * 不区分 app_admin),system_admin 全通。全部写操作写 audit_events。
 */
@RestController
public class KnowledgeController {

    private final KnowledgeService knowledgeService;

    public KnowledgeController(KnowledgeService knowledgeService) {
        this.knowledgeService = knowledgeService;
    }

    /**
     * 查应用知识库(不存在则按需开通)。
     */
    @GetMapping("/api/apps/{appId}/kb")
    public ApiResponse<KnowledgeBaseDto> ensureKb(@PathVariable UUID appId,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.ensureKnowledgeBase(auth, appId));
    }

    /**
     * 按知识库 id 查详情(员工端 knowledge 插件入口)。
     */
    @GetMapping("/api/kb/{kbId}")
    public ApiResponse<KnowledgeBaseDto> getKb(@PathVariable UUID kbId,
                                               @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.getKnowledgeBase(auth, kbId));
    }

    /**
     * 文件夹树(平铺按 path 排序,前端组树)。
     */
    @GetMapping("/api/kb/{kbId}/folders")
    public ApiResponse<List<KbFolderDto>> listFolders(@PathVariable UUID kbId,
                                                      @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.listFolders(auth, kbId));
    }

    /**
     * 建文件夹(同级同名拒绝)。
     */
    @PostMapping("/api/kb/{kbId}/folders")
    public ApiResponse<KbFolderDto> createFolder(@PathVariable UUID kbId,
                                                 @RequestBody CreateFolderRequest body,
                                                 @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.createFolder(auth, kbId, body.name(), body.parentId()));
    }

    /**
     * 重命名/移动文件夹(同步重算子树 path)。
     */
    @PatchMapping("/api/kb/{kbId}/folders/{folderId}")
    public ApiResponse<KbFolderDto> updateFolder(@PathVariable UUID kbId, @PathVariable UUID folderId,
                                                 @RequestBody UpdateFolderRequest body,
                                                 @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.updateFolder(auth, kbId, folderId, body.name(), body.parentId()));
    }

    /**
     * 删文件夹(仅空文件夹)。
     */
    @DeleteMapping("/api/kb/{kbId}/folders/{folderId}")
    public ApiResponse<Void> deleteFolder(@PathVariable UUID kbId, @PathVariable UUID folderId,
                                          @AuthenticationPrincipal AuthContext auth) {
        knowledgeService.deleteFolder(auth, kbId, folderId);
        return ApiResponse.ok();
    }

    /**
     * 列文档。folderId 缺省为根;recursive=true 含子树;kw 关键字检索(仅返回解析 ready);
     * parseStatus 过滤解析状态。
     */
    @GetMapping("/api/kb/{kbId}/documents")
    public ApiResponse<List<KbDocumentDto>> listDocuments(@PathVariable UUID kbId,
                                                          @AuthenticationPrincipal AuthContext auth,
                                                          @RequestParam(required = false) UUID folderId,
                                                          @RequestParam(defaultValue = "false") boolean recursive,
                                                          @RequestParam(required = false) String kw,
                                                          @RequestParam(required = false) String parseStatus) {
        return ApiResponse.ok(knowledgeService.listDocuments(auth, kbId, folderId, recursive, kw, parseStatus));
    }

    /**
     * 上传文档(multipart;目标文件夹可空 = 根;响应为 pending,解析异步进行)。
     */
    @PostMapping(value = "/api/kb/{kbId}/documents", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<KbDocumentDto> uploadDocument(@PathVariable UUID kbId,
                                                     @AuthenticationPrincipal AuthContext auth,
                                                     @RequestPart("file") MultipartFile file,
                                                     @RequestParam(required = false) UUID folderId) {
        return ApiResponse.ok(knowledgeService.uploadDocument(auth, kbId, folderId, file));
    }

    /**
     * 下载文档原文(Storage 经透传 JWT 取回,流式载荷)。
     */
    @GetMapping("/api/kb/{kbId}/documents/{docId}/content")
    public ResponseEntity<byte[]> downloadDocument(@PathVariable UUID kbId, @PathVariable UUID docId,
                                                   @AuthenticationPrincipal AuthContext auth) {
        KbDocumentContentDto content = knowledgeService.downloadDocument(auth, kbId, docId);
        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType(content.contentType()))
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment()
                .filename(content.name(), StandardCharsets.UTF_8).build().toString())
            .body(content.content());
    }

    /**
     * 删除文档(Storage 对象 + 元数据行)。
     */
    @DeleteMapping("/api/kb/{kbId}/documents/{docId}")
    public ApiResponse<Void> deleteDocument(@PathVariable UUID kbId, @PathVariable UUID docId,
                                            @AuthenticationPrincipal AuthContext auth) {
        knowledgeService.deleteDocument(auth, kbId, docId);
        return ApiResponse.ok();
    }
}
