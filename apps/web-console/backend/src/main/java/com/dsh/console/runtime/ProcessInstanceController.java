package com.dsh.console.runtime;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.runtime.dto.CompleteTaskRequest;
import com.dsh.console.runtime.dto.HistoricActivityDto;
import com.dsh.console.runtime.dto.ProcessInstanceDto;
import com.dsh.console.runtime.dto.ProcessVariableDto;
import com.dsh.console.runtime.dto.StartFormVariableDto;
import com.dsh.console.runtime.dto.StartProcessInstanceRequest;
import com.dsh.console.runtime.dto.StartableWorkflowDto;
import com.dsh.console.runtime.dto.TaskDto;
import com.dsh.console.security.AuthContext;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 流程实例运行时 REST 端点。
 *
 * <p>V1 由 Web Console 后端提供端到端联调入口(spec §6.3):
 * <ul>
 *   <li>启动实例:校验 workflow_definition 已发布 + 应用访问权限;注入应用隔离三变量。</li>
 *   <li>列实例:appId 必填(app_admin);system_admin 可不传 appId 查全部;
 *       state 过滤运行中/正常完成/已终止/全部(历史实例对齐主流 BPM 平台审计视图)。</li>
 *   <li>查实例/任务/终止:按 procdefId 反查应用归属校验访问权限;
 *       已结束实例的详情/任务回退历史查询。</li>
 *   <li>查变量/活动/BPMN XML:实例执行审计(上下文变量终值 + 活动路径图渲染)。</li>
 *   <li>完成任务:V1 简化通道,不做输出校验(spec §8.8 在 DSH task-api 层)。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/process-instances")
public class ProcessInstanceController {

    private final ProcessInstanceService instanceService;

    public ProcessInstanceController(ProcessInstanceService instanceService) {
        this.instanceService = instanceService;
    }

    /**
     * 启动表单变量清单(已部署 BPMN 的 start-param 声明,design 2026-09-01 §4)。
     *
     * <p>权限与发起一致(isAuthenticated + Service 层 checkCanStartProcess):
     * 员工发起前需要读取启动参数声明,不再是管理台专属。
     */
    @GetMapping("/start-form")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<List<StartFormVariableDto>> startForm(
        @RequestParam UUID workflowDefinitionId,
        @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.startForm(workflowDefinitionId, auth));
    }

    /**
     * 当前用户可发起的 published 流程清单(员工端 AI 对话发起与管理台发起共用)。
     *
     * <p>system_admin 全部;其余用户限定为自己管理或 active 成员资格的应用。
     */
    @GetMapping("/startable")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<List<StartableWorkflowDto>> startable(
        @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.listStartable(auth));
    }

    /**
     * 启动流程实例。
     *
     * <p>组织维度审批路由(design 2026-09-19 §5.1):system_admin/应用管理员之外,
     * active 应用成员亦可发起(员工端 AI 对话发起的前提);应用归属与发起身份
     * 校验在 Service 层(checkCanStartProcess + resolveApplicantOrgUnit)。
     */
    @PostMapping
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<ProcessInstanceDto> start(@Valid @RequestBody StartProcessInstanceRequest body,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.start(body, auth));
    }

    /**
     * 列实例(运行中/正常完成/已终止/全部)。
     *
     * <p>{@code appId} 给定时只列该应用下 published workflow_definitions 的实例;
     * 不给时 system_admin 查全部,app_admin 自动汇总自己管理的所有应用下的实例。
     * {@code procdefId} 单独过滤时也校验应用访问权限。
     * {@code state} 不传查全部;{@code running} 只看运行中;{@code completed} 只看正常完成;
     * {@code terminated} 只看已终止。
     */
    @GetMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<ProcessInstanceDto>> list(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam(required = false) UUID appId,
        @RequestParam(required = false) String procdefId,
        @RequestParam(required = false) String state,
        @RequestParam(defaultValue = "0") int start,
        @RequestParam(defaultValue = "50") int size) {
        return ApiResponse.ok(instanceService.list(appId, procdefId, state, start, size, auth));
    }

    /**
     * 查实例详情(runtime 优先,已结束回退历史)。
     */
    @GetMapping("/{instanceId}")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<ProcessInstanceDto> get(@PathVariable String instanceId,
                                                @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.getById(instanceId, auth));
    }

    /**
     * 列实例任务(运行中走 runtime;已结束回退历史,含完成时间/终止原因)。
     */
    @GetMapping("/{instanceId}/tasks")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<TaskDto>> listTasks(@PathVariable String instanceId,
                                                 @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.listTasks(instanceId, auth));
    }

    /**
     * 列实例上下文变量(运行中返回当前值,已结束返回终值)。
     */
    @GetMapping("/{instanceId}/variables")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<ProcessVariableDto>> listVariables(@PathVariable String instanceId,
                                                               @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.listVariables(instanceId, auth));
    }

    /**
     * 列实例历史活动(执行路径回溯:节点/类型/处理人/起止时间/耗时,含连线)。
     */
    @GetMapping("/{instanceId}/activities")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<HistoricActivityDto>> listActivities(@PathVariable String instanceId,
                                                                 @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.listActivities(instanceId, auth));
    }

    /**
     * 取实例部署版 BPMN XML(详情页活动路径图渲染用)。
     */
    @GetMapping("/{instanceId}/bpmn-xml")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<String> getBpmnXml(@PathVariable String instanceId,
                                          @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.getBpmnXml(instanceId, auth));
    }

    /**
     * 终止实例(spec §11.2:管理员强制结束)。
     *
     * <p>{@code reason} 可选;不传则默认 "管理员强制终止"。
     */
    @DeleteMapping("/{instanceId}")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<Void> terminate(@PathVariable String instanceId,
                                        @RequestParam(required = false) String reason,
                                        @AuthenticationPrincipal AuthContext auth) {
        instanceService.terminate(instanceId, reason, auth);
        return ApiResponse.ok();
    }

    /**
     * 完成任务(V1 简化通道:不做输出校验,直接转发 Flowable)。
     *
     * <p>真正的代办完成入口在 DSH enterprise profile task-api 层(spec §3 + §8.8),
     * 那里做 ajv 校验 + 缺项回喂。本端点仅供 Web Console 端到端联调使用。
     */
    @PostMapping("/{instanceId}/tasks/{taskId}/complete")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<Void> completeTask(@PathVariable String instanceId,
                                           @PathVariable String taskId,
                                           @RequestBody(required = false) CompleteTaskRequest body,
                                           @AuthenticationPrincipal AuthContext auth) {
        java.util.Map<String, Object> variables = body == null ? null : body.variables();
        instanceService.completeTask(taskId, variables, auth);
        return ApiResponse.ok();
    }
}
