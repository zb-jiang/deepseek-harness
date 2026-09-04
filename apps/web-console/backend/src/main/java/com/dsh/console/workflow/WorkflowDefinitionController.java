package com.dsh.console.workflow;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.security.AuthContext;
import com.dsh.console.workflow.dto.BpmnValidationResult;
import com.dsh.console.workflow.dto.CreateWorkflowRequest;
import com.dsh.console.workflow.dto.PublishResult;
import com.dsh.console.workflow.dto.UpdateBpmnXmlRequest;
import com.dsh.console.workflow.dto.UpdateWorkflowMetaRequest;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 流程定义治理 REST 端点。
 *
 * <p>权限(spec §5.6 + §13.4 应用隔离):
 * <ul>
 *   <li>{@code system_admin} 看全部应用下的流程定义。</li>
 *   <li>{@code app_admin} 只看/操作自己管理应用下的流程定义,由
 *       {@link com.dsh.console.app.ApplicationService#checkCanAccessApp} 在 Service 层校验。</li>
 *   <li>草稿编辑:仅 draft / published 状态可保存 BPMN XML。</li>
 *   <li>发布前校验:BPMN XML 合法 + role_id 归属(spec §12.10 应用隔离不变量)。</li>
 *   <li>停用(status → disabled)和归档(status → archived)不允许新实例启动。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/workflows")
public class WorkflowDefinitionController {

    private final WorkflowDefinitionService workflowService;

    public WorkflowDefinitionController(WorkflowDefinitionService workflowService) {
        this.workflowService = workflowService;
    }

    /**
     * 列流程定义。
     *
     * <p>给 {@code appId} 时只列该应用下的;不给时按当前用户可见范围列出
     * (system_admin 全部,app_admin 仅自己管理的应用)。{@code status} 可选过滤。
     */
    @GetMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<WorkflowDefinitionDto>> list(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam(required = false) UUID appId,
        @RequestParam(required = false) String status,
        @RequestParam(defaultValue = "0") int offset,
        @RequestParam(defaultValue = "50") int limit) {
        if (appId != null) {
            return ApiResponse.ok(workflowService.listByApp(appId, auth));
        }
        return ApiResponse.ok(workflowService.list(status, offset, limit, auth));
    }

    /**
     * 查流程定义详情(含草稿 BPMN XML,供画布回填)。
     */
    @GetMapping("/{workflowId}")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<WorkflowDefinitionDto> get(@PathVariable UUID workflowId,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(workflowService.getById(workflowId, auth));
    }

    /**
     * 创建流程定义草稿(不含 BPMN XML,后续通过 PATCH 单独保存)。
     */
    @PostMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<WorkflowDefinitionDto> create(@Valid @RequestBody CreateWorkflowRequest body,
                                                      @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(workflowService.create(body, auth.platformUserId(), auth));
    }

    /**
     * 保存草稿 BPMN XML(画布"保存"按钮)。
     *
     * <p>仅 draft / published 状态可保存;disabled / archived 终态不允许编辑。
     */
    @PatchMapping("/{workflowId}/draft-bpmn")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<WorkflowDefinitionDto> updateDraftBpmn(
        @PathVariable UUID workflowId,
        @Valid @RequestBody UpdateBpmnXmlRequest body,
        @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(
            workflowService.updateDraftBpmnXml(workflowId, body, auth.platformUserId(), auth));
    }

    /**
     * 修改流程定义元数据(name / description)。
     */
    @PatchMapping("/{workflowId}/meta")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<WorkflowDefinitionDto> updateMeta(
        @PathVariable UUID workflowId,
        @Valid @RequestBody UpdateWorkflowMetaRequest body,
        @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(
            workflowService.updateMeta(workflowId, body, auth.platformUserId(), auth));
    }

    /**
     * 校验草稿 BPMN XML,不发布(供前端"预览校验"按钮)。
     */
    @PostMapping("/{workflowId}/validate")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<BpmnValidationResult> validate(@PathVariable UUID workflowId,
                                                       @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(workflowService.validateBpmn(workflowId, auth));
    }

    /**
     * 发布流程定义:校验 BPMN → 部署到 Flowable → 更新本地状态为 published。
     */
    @PostMapping("/{workflowId}/publish")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<PublishResult> publish(@PathVariable UUID workflowId,
                                               @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(workflowService.publish(workflowId, auth.platformUserId(), auth));
    }

    /**
     * 停用流程定义(status → disabled,不允许新实例启动)。
     */
    @PostMapping("/{workflowId}/disable")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<WorkflowDefinitionDto> disable(@PathVariable UUID workflowId,
                                                       @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(workflowService.disable(workflowId, auth.platformUserId(), auth));
    }

    /**
     * 归档流程定义(status → archived,终态)。
     */
    @PostMapping("/{workflowId}/archive")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<WorkflowDefinitionDto> archive(@PathVariable UUID workflowId,
                                                       @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(workflowService.archive(workflowId, auth.platformUserId(), auth));
    }
}
