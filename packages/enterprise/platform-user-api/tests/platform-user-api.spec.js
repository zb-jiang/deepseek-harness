import { Context } from '@deepseek-ai/cordis';
import { describe, it, expect, beforeEach } from 'vitest';
const { apply } = await import("../src/index.js");
/** 最小 WebServer 桩，收集注册的路由。 */
function createStubWebServer() {
    const routes = [];
    return {
        routes,
        register(route) {
            routes.push(route);
            return () => {
                const idx = routes.indexOf(route);
                if (idx >= 0)
                    routes.splice(idx, 1);
            };
        },
        registerUpgrade() { return () => { }; },
        registerFallback() { return () => { }; },
        tapIndex() { return () => { }; },
        applyIndexTaps(html) { return html; },
        host: '127.0.0.1',
        port: 0,
    };
}
/** 最小 PlatformUsers 桩。 */
function createStubPlatformUsers() {
    const users = [];
    let nextId = 1;
    return {
        async registerPendingUser(req) {
            const user = {
                id: `u${nextId++}`,
                authSubject: req.authSubject,
                loginName: req.loginName,
                displayName: req.displayName,
                email: req.email,
                status: 'pending_approval',
                platformRoles: [],
                createdAt: new Date().toISOString(),
            };
            users.push(user);
            return user;
        },
        async getById(id) {
            return users.find(u => u.id === id);
        },
        async getByAuthSubject(s) {
            return users.find(u => u.authSubject === s);
        },
        async list() {
            return users;
        },
        async approve(id, req) {
            const u = users.find(u => u.id === id);
            u.status = 'active';
            u.platformRoles = req.platformRoles;
            u.approvedAt = new Date().toISOString();
            u.approvedBy = req.approvedBy;
            return u;
        },
        async setRoles(id, req) {
            const u = users.find(u => u.id === id);
            u.platformRoles = req.platformRoles;
            return u;
        },
        async disable(id, req) {
            const u = users.find(u => u.id === id);
            u.status = 'disabled';
            u.disabledAt = new Date().toISOString();
            u.disabledBy = req.disabledBy;
            return u;
        },
        async lock(id, req) {
            const u = users.find(u => u.id === id);
            u.status = 'locked';
            u.lockedAt = new Date().toISOString();
            u.lockedBy = req.lockedBy;
            return u;
        },
        async restore(id, req) {
            const u = users.find(u => u.id === id);
            u.status = 'active';
            return u;
        },
    };
}
/** 模拟 IncomingMessage。 */
function mockReq(method, url, body) {
    const bodyStr = body ? JSON.stringify(body) : '';
    return {
        method,
        url,
        headers: {},
        async *[Symbol.asyncIterator]() {
            if (bodyStr)
                yield Buffer.from(bodyStr);
        },
    };
}
/** 模拟 ServerResponse。 */
function mockRes() {
    let statusCode = 0;
    let body = '';
    const res = {
        writeHead(status) { statusCode = status; },
        end(data) { body = data ?? ''; },
    };
    return { res, statusCode, get body() { return body; } };
}
describe('platform-user-api', () => {
    let ctx;
    let stubWebServer;
    let stubUsers;
    beforeEach(() => {
        ctx = new Context();
        stubWebServer = createStubWebServer();
        stubUsers = createStubPlatformUsers();
        ctx.provide('webServer', stubWebServer);
        ctx.provide('platformUsers', stubUsers);
    });
    it('注册前缀路由 /api/enterprise/platform-users', () => {
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        expect(stubWebServer.routes).toHaveLength(1);
        expect(stubWebServer.routes[0].kind).toBe('prefix');
        expect(stubWebServer.routes[0].path).toBe('/api/enterprise/platform-users');
    });
    it('GET / 列出用户', async () => {
        await stubUsers.registerPendingUser({ authSubject: 'sub1', loginName: 'alice', displayName: 'Alice', email: 'a@x.com' });
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        const handler = stubWebServer.routes[0].handler;
        const { res, statusCode, body } = mockRes();
        await handler(mockReq('GET', '/api/enterprise/platform-users'), res);
        expect(statusCode).toBe(200);
        const parsed = JSON.parse(body);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].loginName).toBe('alice');
    });
    it('POST /register 注册新用户', async () => {
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        const handler = stubWebServer.routes[0].handler;
        const { res, statusCode, body } = mockRes();
        await handler(mockReq('POST', '/api/enterprise/platform-users/register', {
            authSubject: 'sub2', loginName: 'bob', displayName: 'Bob', email: 'b@x.com',
        }), res);
        expect(statusCode).toBe(201);
        const parsed = JSON.parse(body);
        expect(parsed.loginName).toBe('bob');
        expect(parsed.status).toBe('pending_approval');
    });
    it('POST /:id/approve 审批用户', async () => {
        const user = await stubUsers.registerPendingUser({ authSubject: 'sub3', loginName: 'carol', displayName: 'Carol', email: 'c@x.com' });
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        const handler = stubWebServer.routes[0].handler;
        const { res, statusCode, body } = mockRes();
        await handler(mockReq('POST', `/api/enterprise/platform-users/${user.id}/approve`, {
            approvedBy: 'admin1', platformRoles: ['normal_user'],
        }), res);
        expect(statusCode).toBe(200);
        const parsed = JSON.parse(body);
        expect(parsed.status).toBe('active');
        expect(parsed.platformRoles).toEqual(['normal_user']);
    });
    it('POST /:id/disable 禁用用户', async () => {
        const user = await stubUsers.registerPendingUser({ authSubject: 'sub4', loginName: 'dave', displayName: 'Dave', email: 'd@x.com' });
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        const handler = stubWebServer.routes[0].handler;
        const { res, statusCode, body } = mockRes();
        await handler(mockReq('POST', `/api/enterprise/platform-users/${user.id}/disable`, {
            disabledBy: 'admin1',
        }), res);
        expect(statusCode).toBe(200);
        const parsed = JSON.parse(body);
        expect(parsed.status).toBe('disabled');
    });
    it('PUT /:id/roles 更新角色', async () => {
        const user = await stubUsers.registerPendingUser({ authSubject: 'sub5', loginName: 'eve', displayName: 'Eve', email: 'e@x.com' });
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        const handler = stubWebServer.routes[0].handler;
        const { res, statusCode, body } = mockRes();
        await handler(mockReq('PUT', `/api/enterprise/platform-users/${user.id}/roles`, {
            changedBy: 'admin1', platformRoles: ['app_admin'],
        }), res);
        expect(statusCode).toBe(200);
        const parsed = JSON.parse(body);
        expect(parsed.platformRoles).toEqual(['app_admin']);
    });
    it('GET /:id 获取不存在的用户返回 404', async () => {
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        const handler = stubWebServer.routes[0].handler;
        const { res, statusCode, body } = mockRes();
        await handler(mockReq('GET', '/api/enterprise/platform-users/nonexistent'), res);
        expect(statusCode).toBe(404);
    });
    it('POST /register 缺少字段返回 400', async () => {
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        const handler = stubWebServer.routes[0].handler;
        const { res, statusCode, body } = mockRes();
        await handler(mockReq('POST', '/api/enterprise/platform-users/register', { authSubject: 'x' }), res);
        expect(statusCode).toBe(400);
    });
    it('未匹配的路由返回 404', async () => {
        ctx.plugin({ name: 'test', apply, inject: ['webServer', 'platformUsers'] });
        const handler = stubWebServer.routes[0].handler;
        const { res, statusCode } = mockRes();
        await handler(mockReq('DELETE', '/api/enterprise/platform-users/123'), res);
        expect(statusCode).toBe(404);
    });
});
//# sourceMappingURL=platform-user-api.spec.js.map