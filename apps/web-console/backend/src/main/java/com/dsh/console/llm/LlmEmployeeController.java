package com.dsh.console.llm;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.llm.dto.EmployeeModelDto;
import com.dsh.console.security.AuthContext;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 员工端 LLM API。
 * 业务含义:员工登录后拉取自己可用的企业模型目录,供员工端模型选择器展示。
 */
@RestController
@RequestMapping("/api/llm")
@PreAuthorize("isAuthenticated()")
public class LlmEmployeeController {

    private final LlmEmployeeService employeeService;

    public LlmEmployeeController(LlmEmployeeService employeeService) {
        this.employeeService = employeeService;
    }

    /** 当前员工可用模型目录,含各额度池当月概况。 */
    @GetMapping("/models")
    public ApiResponse<List<EmployeeModelDto>> listModels(@AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(employeeService.listModelsForUser(auth.platformUserId()));
    }
}
