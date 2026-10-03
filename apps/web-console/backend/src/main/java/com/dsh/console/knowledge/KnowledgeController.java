package com.dsh.console.knowledge;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.knowledge.dto.CreateFolderRequest;
import com.dsh.console.knowledge.dto.KbAppSummaryDto;
import com.dsh.console.knowledge.dto.KbDocumentContentDto;
import com.dsh.console.knowledge.dto.KbDocumentDto;
import com.dsh.console.knowledge.dto.KbDocumentTextDto;
import com.dsh.console.knowledge.dto.KbFolderDto;
import com.dsh.console.knowledge.dto.KbSearchHitDto;
import com.dsh.console.knowledge.dto.KbSearchTraceDto;
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
     * 按应用查知识库(成员可读,不开通;未开通 404)。员工端待办会话的
     * 知识库选择器入口。
     */
    @GetMapping("/api/kb/by-app/{appId}")
    public ApiResponse<KnowledgeBaseDto> findKbByApp(@PathVariable UUID appId,
                                                     @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.findKnowledgeBaseByApp(auth, appId));
    }

    /**
     * 当前用户可见的知识库清单(应用管理员 ∪ active 成员的应用)。
     * 员工端工作空间上传「选应用」数据源。
     */
    @GetMapping("/api/kb/mine")
    public ApiResponse<List<KbAppSummaryDto>> listMyKbs(@AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.listKbsForUser(auth));
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
     * 混合检索(文档级):向量 + pg_trgm 关键词 + jiebacfg 全文三路候选按 RRF 融合
     * 排序,统一聚合为文档级命中(同文档只出现一条),只返回解析 ready 的文档。
     * folderId 限定其子树(含自身),缺省全库;topK 缺省 8,超范围自动收敛到 1~50。
     */
    @GetMapping("/api/kb/{kbId}/search")
    public ApiResponse<List<KbSearchHitDto>> search(@PathVariable UUID kbId,
                                                    @AuthenticationPrincipal AuthContext auth,
                                                    @RequestParam String query,
                                                    @RequestParam(required = false) UUID folderId,
                                                    @RequestParam(required = false) Integer topK) {
        return ApiResponse.ok(knowledgeService.searchChunks(auth, kbId, query, folderId, topK));
    }

    /**
     * 混合检索 debug 追踪(web console「知识库」检索可视化页面):执行与
     * {@link #search} 完全相同的检索流程,额外返回三路候选、文档级 RRF 融合明细
     * 与最终命中,用于直观展示打分与排序过程。每次调用真实执行一次查询向量化。
     */
    @GetMapping("/api/kb/{kbId}/search-debug")
    public ApiResponse<KbSearchTraceDto> searchDebug(@PathVariable UUID kbId,
                                                     @AuthenticationPrincipal AuthContext auth,
                                                     @RequestParam String query,
                                                     @RequestParam(required = false) UUID folderId,
                                                     @RequestParam(required = false) Integer topK) {
        return ApiResponse.ok(knowledgeService.searchTrace(auth, kbId, query, folderId, topK));
    }

    /**
     * 上传文档(multipart;目标文件夹可空 = 根;chunk 参数可空取配置默认;响应为 pending,
     * 解析异步进行——多文档上传各自入队串行处理)。
     */
    @PostMapping(value = "/api/kb/{kbId}/documents", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<KbDocumentDto> uploadDocument(@PathVariable UUID kbId,
                                                     @AuthenticationPrincipal AuthContext auth,
                                                     @RequestPart("file") MultipartFile file,
                                                     @RequestParam(required = false) UUID folderId,
                                                     @RequestParam(required = false) Integer chunkMaxSize,
                                                     @RequestParam(required = false) Integer chunkOverlap,
                                                     @RequestParam(required = false) String chunkSeparator) {
        return ApiResponse.ok(knowledgeService.uploadDocument(auth, kbId, folderId, file,
            chunkMaxSize, chunkOverlap, chunkSeparator));
    }

    /**
     * 重新解析(从 Storage 回读原文重走抽取 → chunk → embedding 全管线;
     * chunk 参数可空沿用文档当前值;解析中拒绝)。
     */
    @PostMapping("/api/kb/{kbId}/documents/{docId}/reparse")
    public ApiResponse<KbDocumentDto> reparseDocument(@PathVariable UUID kbId,
                                                      @PathVariable UUID docId,
                                                      @AuthenticationPrincipal AuthContext auth,
                                                      @RequestBody(required = false) ReparseRequest body) {
        ReparseRequest request = body == null ? ReparseRequest.EMPTY : body;
        return ApiResponse.ok(knowledgeService.reparseDocument(auth, kbId, docId,
            request.chunkMaxSize(), request.chunkOverlap(), request.chunkSeparator()));
    }

    /**
     * 重新解析请求体(全字段可选,缺省沿用文档当前值)。
     */
    record ReparseRequest(Integer chunkMaxSize, Integer chunkOverlap, String chunkSeparator) {
        static final ReparseRequest EMPTY = new ReparseRequest(null, null, null);
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
     * 读文档抽取全文(员工端 kb_read 工具;按 docId 直查,KB 归属服务层推导)。
     */
    @GetMapping("/api/kb/documents/{docId}/text")
    public ApiResponse<KbDocumentTextDto> readDocumentText(@PathVariable UUID docId,
                                                           @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.readDocumentText(auth, docId));
    }

    /**
     * 按文档 id 查元数据(员工端历史消息 KB 徽标;按 docId 直查,KB 归属服务层推导)。
     */
    @GetMapping("/api/kb/documents/{docId}")
    public ApiResponse<KbDocumentDto> getDocument(@PathVariable UUID docId,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(knowledgeService.getDocument(auth, docId));
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
