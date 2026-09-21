package com.dsh.console.runtime;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.orgunit.OrgUnitService;
import com.dsh.console.orgunit.dto.OrgPositionDto;
import com.dsh.console.security.AuthContext;
import java.util.List;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 流程发起侧运行时 REST 端点(当前登录人视角)。
 *
 * <p>组织维度审批路由(design 2026-09-19 §5.1):DSH 员工端(经本地 webserver 代理)
 * 与管理台发起对话框都用 my-org-positions 拉取当前用户组织位置,据此决定
 * 发起身份(多身份必选、唯一自动、无身份且流程不含同行政线节点免选)。
 */
@RestController
@RequestMapping("/api/runtime")
@PreAuthorize("isAuthenticated()")
public class RuntimeController {

    private final OrgUnitService orgUnitService;

    public RuntimeController(OrgUnitService orgUnitService) {
        this.orgUnitService = orgUnitService;
    }

    /**
     * 当前登录人的组织位置清单(部门 id/名称/到根路径,多对多全部隶属)。
     */
    @GetMapping("/my-org-positions")
    public ApiResponse<List<OrgPositionDto>> myOrgPositions(@AuthenticationPrincipal AuthContext auth) {
        return ApiResponse.ok(orgUnitService.positionsForUser(auth.platformUserId()));
    }
}
