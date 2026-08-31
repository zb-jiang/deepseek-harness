package com.dsh.console.runtime;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.runtime.dto.CompleteTaskRequest;
import com.dsh.console.runtime.dto.ProcessInstanceDto;
import com.dsh.console.runtime.dto.StartProcessInstanceRequest;
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
 *   <li>列实例:appId 必填(app_admin);system_admin 可不传 appId 查全部。</li>
 *   <li>查实例/任务/终止:按 procdefId 反查应用归属校验访问权限。</li>
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
     * 启动流程实例。
     */
    @PostMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<ProcessInstanceDto> start(@Valid @RequestBody StartProcessInstanceRequest body,
                                                  @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.start(body, auth));
    }

    /**
     * 列运行中实例(runtime)。
     *
     * <p>{@code appId} 给定时只列该应用下 published workflow_definitions 的运行实例;
     * 不给时 system_admin 查全部,app_admin 自动汇总自己管理的所有应用下的实例。
     * {@code procdefId} 单独过滤时也校验应用访问权限。
     */
    @GetMapping
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<ProcessInstanceDto>> list(
        @AuthenticationPrincipal AuthContext auth,
        @RequestParam(required = false) UUID appId,
        @RequestParam(required = false) String procdefId,
        @RequestParam(defaultValue = "0") int start,
        @RequestParam(defaultValue = "50") int size) {
        return ApiResponse.ok(instanceService.list(appId, procdefId, start, size, auth));
    }

    /**
     * 查运行中实例详情。
     */
    @GetMapping("/{instanceId}")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<ProcessInstanceDto> get(@PathVariable String instanceId,
                                                @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.getById(instanceId, auth));
    }

    /**
     * 列实例当前任务(runtime tasks)。
     */
    @GetMapping("/{instanceId}/tasks")
    @PreAuthorize("hasAnyRole('SYSTEM_ADMIN', 'APP_ADMIN')")
    public ApiResponse<List<TaskDto>> listTasks(@PathVariable String instanceId,
                                                 @AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(instanceService.listTasks(instanceId, auth));
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
