package com.dsh.console.knowledge;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.knowledge.dto.BackendKbResolveDto;
import com.dsh.console.knowledge.dto.KbDocumentDto;
import com.dsh.console.knowledge.dto.KbDocumentTextDto;
import com.dsh.console.knowledge.dto.KbFolderDto;
import com.dsh.console.knowledge.dto.KbSearchHitDto;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 后端知识库只读端点(X-Service-Key 服务身份,backend profile 无人值守 kb_* 工具与
 * flowable-engine 的 backend task kb 解析消费)。
 *
 * <p>鉴权不走员工 JWT:由 {@code ServiceKeyAuthFilter} 的白名单
 * {@code GET /api/backend/kb/**} 放行,控制器不使用 {@code @AuthenticationPrincipal}。
 * 权限语义为「服务身份代表应用本身,只能读」:流程归属解析按
 * published_procdef_id 直查、miss 时按 bpmn_process_key 回退(与流程实例归属
 * 解析同序);检索/全文不做员工成员校验,误读防护由 Node 侧会话持有 kbId 圈定
 * (服务密钥是进程级全权凭证,不防 Node 进程被攻破——设计取舍,升级路径为
 * 每任务短时作用域凭证)。
 */
@RestController
@RequestMapping("/api/backend/kb")
public class BackendKbController {

    private final KnowledgeService knowledgeService;
    private final WorkflowDefinitionJdbcRepository workflowRepository;

    public BackendKbController(KnowledgeService knowledgeService,
                               WorkflowDefinitionJdbcRepository workflowRepository) {
        this.knowledgeService = knowledgeService;
        this.workflowRepository = workflowRepository;
    }

    /**
     * 按流程定义解析所属工程的知识库:procdefId 直查 workflow_definitions
     * (published_procdef_id),历史/非当前版本 miss 时按 BPMN key 段回退。
     * 应用未开通知识库 → 404(调用方按「无知识库」降级,不注入)。
     */
    @GetMapping("/resolve")
    public ApiResponse<BackendKbResolveDto> resolve(@RequestParam String processDefinitionId) {
        WorkflowDefinitionDto definition = workflowRepository.findByProcdefId(processDefinitionId)
            .or(() -> workflowRepository.findByBpmnProcessKey(extractBpmnKey(processDefinitionId)))
            .orElseThrow(() -> new NotFoundException(
                "流程定义不存在或未归属任何工程: " + processDefinitionId));
        return knowledgeService.findKbByAppForService(definition.appId())
            .map(kb -> ApiResponse.ok(new BackendKbResolveDto(kb.id(), kb.name())))
            .orElseThrow(() -> new NotFoundException(
                "流程所属应用未开通知识库: " + processDefinitionId));
    }

    /** 列知识库文件夹树,语义同员工端 {@code GET /api/kb/{kbId}/folders}。 */
    @GetMapping("/{kbId}/folders")
    public ApiResponse<List<KbFolderDto>> listFolders(@PathVariable UUID kbId) {
        return ApiResponse.ok(knowledgeService.listFoldersForService(kbId));
    }

    /**
     * 检索知识库文档,参数语义同员工端 {@code GET /api/kb/{kbId}/documents}
     * (folderId/recursive/kw/parseStatus;全文不进列表载荷)。
     */
    @GetMapping("/{kbId}/documents")
    public ApiResponse<List<KbDocumentDto>> listDocuments(@PathVariable UUID kbId,
                                                          @RequestParam(required = false) UUID folderId,
                                                          @RequestParam(defaultValue = "false") boolean recursive,
                                                          @RequestParam(required = false) String kw,
                                                          @RequestParam(required = false) String parseStatus) {
        return ApiResponse.ok(
            knowledgeService.listDocumentsForService(kbId, folderId, recursive, kw, parseStatus));
    }

    /**
     * 混合检索知识库文档,参数语义同员工端 {@code GET /api/kb/{kbId}/search}
     * (query/folderId/topK;向量 + 关键词 + 全文三路 RRF 融合为文档级命中,
     * 只返回解析 ready)。
     */
    @GetMapping("/{kbId}/search")
    public ApiResponse<List<KbSearchHitDto>> search(@PathVariable UUID kbId,
                                                    @RequestParam String query,
                                                    @RequestParam(required = false) UUID folderId,
                                                    @RequestParam(required = false) Integer topK) {
        return ApiResponse.ok(knowledgeService.searchChunksForService(kbId, query, folderId, topK));
    }

    /** 读文档全文,语义同员工端 {@code GET /api/kb/documents/{docId}/text}。 */
    @GetMapping("/documents/{docId}/text")
    public ApiResponse<KbDocumentTextDto> readDocumentText(@PathVariable UUID docId) {
        return ApiResponse.ok(knowledgeService.readDocumentTextForService(docId));
    }

    /** 取 {@code key:version:uuid} 形态的首段;无冒号原样返回。 */
    private static String extractBpmnKey(String processDefinitionId) {
        int colon = processDefinitionId.indexOf(':');
        return colon < 0 ? processDefinitionId : processDefinitionId.substring(0, colon);
    }
}
