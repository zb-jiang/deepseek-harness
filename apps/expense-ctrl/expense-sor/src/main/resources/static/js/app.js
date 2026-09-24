/* 费控报销 Web UI
 * 认证链路与 headless API 完全一致:Supabase Auth 直连登录拿 JWT(access_token),
 * 所有 /api 调用带 Authorization: Bearer <token>,由 SOR 端 JWKS 验签(ES256/RS256)。
 * 人工审批写入的幂等键:processInstanceId = "manual-ui-<reportId>",activityId = "manual-ui"
 * (数据库唯一约束为 (process_instance_id, activity_id, approver_id),不带 report_id,
 *  因此 pid 必须带上单据 id,否则同一审批人全库只能写一条审批记录)。
 */
(function () {
  'use strict';

  const { createApp, reactive, computed, ref } = Vue;

  const STATUSES = ['opened', 'ongoing', 'approved', 'paid', 'rejected', 'cancelled'];
  const STATUS_TEXT = {
    opened: '待审批', ongoing: '审批中', approved: '已批准',
    paid: '已支付', rejected: '已拒绝', cancelled: '已撤回'
  };
  const CATEGORIES = ['交通', '住宿', '餐饮', '办公', '其他'];
  const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

  createApp({
    setup() {
      // ---------- 全局状态 ----------
      const booting = ref(true);
      const uiConfig = reactive({ supabaseUrl: '', supabaseAnonKey: '' });
      const me = ref(null);            // {sub, email, displayName}
      const route = ref('list');
      const detailId = ref(null);
      const toast = ref('');

      let supabase = null;

      const displayName = computed(() => {
        const m = me.value;
        return m ? (m.displayName || m.email || m.sub) : '';
      });

      function showToast(msg) {
        toast.value = msg;
        setTimeout(() => { toast.value = ''; }, 3500);
      }

      // ---------- 路由(hash,免构建) ----------
      function parseHash() {
        const h = (location.hash || '#/list').slice(2);
        if (h.startsWith('detail/')) {
          route.value = 'detail';
          detailId.value = h.slice(7);
          loadDetail();
        } else if (['list', 'create'].includes(h)) {
          route.value = h;
          if (h === 'list') loadList();
        } else {
          route.value = 'list';
          loadList();
        }
      }
      window.addEventListener('hashchange', parseHash);

      // ---------- API 封装(统一信封解包) ----------
      async function api(path, options) {
        const opts = Object.assign({ headers: {} }, options || {});
        const session = supabase ? (await supabase.auth.getSession()).data.session : null;
        if (session) opts.headers['Authorization'] = 'Bearer ' + session.access_token;
        if (opts.body && !(opts.body instanceof FormData)) {
          opts.headers['Content-Type'] = 'application/json';
        }
        const res = await fetch(path, opts);
        let payload = null;
        try { payload = await res.json(); } catch (e) { /* 附件等原始响应 */ }
        if (!res.ok || (payload && typeof payload.code === 'number' && payload.code !== 0)) {
          const msg = (payload && payload.message) ? payload.message : ('请求失败(HTTP ' + res.status + ')');
          if (res.status === 401 && me.value) { forceRelogin(); }
          const err = new Error(msg);
          err.payload = payload;
          throw err;
        }
        return payload && typeof payload.code === 'number' ? payload.data : payload;
      }

      function forceRelogin() {
        me.value = null;
        loginError.value = '登录已过期,请重新登录';
      }

      // ---------- 登录/登出 ----------
      const loginForm = reactive({ email: '', password: '' });
      const loggingIn = ref(false);
      const loginError = ref('');

      async function login() {
        loginError.value = '';
        loggingIn.value = true;
        try {
          const { error } = await supabase.auth.signInWithPassword({
            email: loginForm.email, password: loginForm.password
          });
          if (error) throw new Error(error.message);
          await afterLogin();           // onAuthStateChange 也会触发,双保险不冲突
          loginForm.password = '';
        } catch (e) {
          loginError.value = '登录失败:' + e.message;
        } finally {
          loggingIn.value = false;
        }
      }

      async function logout() {
        try { await supabase.auth.signOut(); } catch (e) { /* 忽略 */ }
        me.value = null;
        location.hash = '#/list';
      }

      async function afterLogin() {
        const data = await api('/api/me');
        me.value = data;
        parseHash();
      }

      // ---------- 列表 ----------
      const list = ref([]);
      const loadingList = ref(false);
      const listFilter = reactive({ status: '', mine: false });

      async function loadList() {
        if (!me.value) return;
        loadingList.value = true;
        try {
          const params = new URLSearchParams();
          if (listFilter.status) params.set('status', listFilter.status);
          if (listFilter.mine) params.set('submitterId', me.value.sub);
          params.set('limit', '100');
          list.value = await api('/api/expenses?' + params.toString());
        } catch (e) {
          showToast(e.message);
        } finally {
          loadingList.value = false;
        }
      }

      // ---------- 创建报销单 ----------
      const createForm = reactive({
        title: '', reason: '',
        items: [newItem()],
        attachments: []   // 已上传附件 {id, fileName, sizeBytes, uploading}
      });
      const creating = ref(false);
      const createError = ref('');

      function newItem() {
        return { category: '交通', amount: '', occurredDate: today(), description: '' };
      }
      function today() {
        return new Date().toISOString().slice(0, 10);
      }
      function addItem() { createForm.items.push(newItem()); }
      function removeItem(i) { createForm.items.splice(i, 1); }

      const createTotal = computed(() => {
        return createForm.items.reduce((sum, it) => {
          return sum + (AMOUNT_RE.test(it.amount) ? parseFloat(it.amount) : 0);
        }, 0);
      });

      async function onPickFiles(ev) {
        const files = Array.from(ev.target.files || []);
        ev.target.value = '';
        for (const file of files) {
          const entry = reactive({ id: 'pending-' + Math.random().toString(36).slice(2),
            fileName: file.name, sizeBytes: file.size, uploading: true });
          createForm.attachments.push(entry);
          try {
            const fd = new FormData();
            fd.append('file', file);
            const meta = await api('/api/expenses/attachments', { method: 'POST', body: fd });
            Object.assign(entry, { id: meta.id, sizeBytes: meta.sizeBytes, uploading: false });
          } catch (e) {
            createForm.attachments = createForm.attachments.filter(a => a !== entry);
            showToast('附件「' + file.name + '」上传失败:' + e.message);
          }
        }
      }

      function removeAttachment(id) {
        createForm.attachments = createForm.attachments.filter(a => a.id !== id);
      }

      async function submitCreate() {
        createError.value = '';
        for (const it of createForm.items) {
          if (!AMOUNT_RE.test(it.amount)) {
            createError.value = '明细金额格式非法(最多两位小数的正数,如 1500.00)';
            return;
          }
        }
        creating.value = true;
        try {
          const created = await api('/api/expenses', {
            method: 'POST',
            body: JSON.stringify({
              title: createForm.title,
              reason: createForm.reason,
              submitterName: displayName.value,
              items: createForm.items.map(it => ({
                category: it.category, amount: it.amount,
                occurredDate: it.occurredDate, description: it.description
              })),
              attachmentIds: createForm.attachments.filter(a => !a.uploading).map(a => a.id)
            })
          });
          resetCreateForm();
          location.hash = '#/detail/' + created.id;
          showToast('报销单已提交');
        } catch (e) {
          createError.value = e.message;
        } finally {
          creating.value = false;
        }
      }

      function resetCreateForm() {
        createForm.title = ''; createForm.reason = '';
        createForm.items = [newItem()];
        createForm.attachments = [];
      }

      // ---------- 详情 ----------
      const detail = ref(null);
      const approving = ref(false);
      const paying = ref(false);
      const cancelling = ref(false);
      const approvalForm = reactive({ comment: '' });
      const paymentForm = reactive({ amount: '', channel: '银行转账', comment: '' });

      async function loadDetail() {
        if (!me.value || !detailId.value) return;
        try {
          detail.value = await api('/api/expenses/' + detailId.value);
          if (!paymentForm.amount) paymentForm.amount = String(detail.value.totalAmount);
        } catch (e) {
          showToast(e.message);
          detail.value = null;
        }
      }

      const isMine = computed(() =>
        detail.value && me.value && detail.value.submitterId === me.value.sub);
      const canApprove = computed(() =>
        detail.value && ['opened', 'ongoing'].includes(detail.value.status));
      const canCancel = computed(() =>
        isMine.value && detail.value && ['ongoing', 'approved'].includes(detail.value.status));

      // 审批三选项:reject=拒绝;agree=同意(保持 ongoing);final=审批通过(approved)
      async function doApprove(kind) {
        approving.value = true;
        try {
          const decision = kind === 'reject' ? 'reject' : 'approve';
          const body = {
            processInstanceId: 'manual-ui-' + detailId.value,
            activityId: 'manual-ui',
            decision: decision,
            comment: approvalForm.comment || null,
            approverId: me.value.sub,
            approverName: displayName.value
          };
          if (kind === 'final') body.targetStatus = 'approved';
          const result = await api('/api/expenses/' + detailId.value + '/approval-records', {
            method: 'POST', body: JSON.stringify(body)
          });
          if (result && result.duplicated) {
            showToast('您已审批过该单据,本次操作被幂等去重(状态未变化)');
          } else {
            showToast(kind === 'reject' ? '已拒绝' : (kind === 'final' ? '已审批通过' : '已同意'));
          }
          approvalForm.comment = '';
          await loadDetail();
        } catch (e) {
          showToast(e.message);
        } finally {
          approving.value = false;
        }
      }

      async function doPay() {
        if (!AMOUNT_RE.test(paymentForm.amount)) {
          showToast('支付金额格式非法(最多两位小数的正数)');
          return;
        }
        paying.value = true;
        try {
          await api('/api/expenses/' + detailId.value + '/payment', {
            method: 'POST',
            body: JSON.stringify({
              amount: paymentForm.amount,
              channel: paymentForm.channel,
              comment: paymentForm.comment || null,
              paidBy: me.value.sub,
              paidName: displayName.value
            })
          });
          showToast('支付完成,单据已置为已支付');
          await loadDetail();
        } catch (e) {
          showToast(e.message);
        } finally {
          paying.value = false;
        }
      }

      async function doCancel() {
        if (!window.confirm('确认撤回该报销单?撤回后不可恢复。')) return;
        cancelling.value = true;
        try {
          await api('/api/expenses/' + detailId.value + '/cancel', { method: 'POST' });
          showToast('已撤回');
          await loadDetail();
        } catch (e) {
          showToast(e.message);
        } finally {
          cancelling.value = false;
        }
      }

      // 附件下载(需带 Bearer 头,<a href> 无法携带,故走 blob)
      async function downloadAttachment(att) {
        try {
          const opts = {};
          const session = (await supabase.auth.getSession()).data.session;
          if (session) opts.headers = { 'Authorization': 'Bearer ' + session.access_token };
          const res = await fetch('/api/expenses/' + detailId.value + '/attachments/' + att.id, opts);
          if (!res.ok) throw new Error('下载失败(HTTP ' + res.status + ')');
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = att.fileName;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (e) {
          showToast(e.message);
        }
      }

      // ---------- 展示工具 ----------
      function statusText(s) { return STATUS_TEXT[s] || s; }
      function money(v) {
        const n = Number(v);
        return isNaN(n) ? String(v) : '¥ ' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2 });
      }
      function fileSize(bytes) {
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
        if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
        return bytes + ' B';
      }
      function fmtTime(v) {
        if (!v) return '—';
        const d = new Date(v);
        return isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN', { hour12: false });
      }
      function goDetail(id) { location.hash = '#/detail/' + id; }

      // ---------- 启动 ----------
      (async function boot() {
        try {
          const cfg = await api('/api/ui-config');   // 匿名端点
          uiConfig.supabaseUrl = cfg.supabaseUrl || '';
          uiConfig.supabaseAnonKey = cfg.supabaseAnonKey || '';
          if (uiConfig.supabaseUrl) {
            supabase = window.supabase.createClient(uiConfig.supabaseUrl, uiConfig.supabaseAnonKey);
            const { data } = await supabase.auth.getSession();
            if (data && data.session) {
              await afterLogin();
            }
            supabase.auth.onAuthStateChange((event) => {
              if (event === 'SIGNED_OUT') { me.value = null; }
              if (event === 'SIGNED_IN' && !me.value) { afterLogin().catch(() => {}); }
            });
          }
        } catch (e) {
          showToast('初始化失败:' + e.message);
        } finally {
          booting.value = false;
          parseHash();
        }
      })();

      return {
        booting, uiConfig, me, route, toast, displayName,
        STATUSES, CATEGORIES,
        loginForm, loggingIn, loginError, login, logout,
        list, loadingList, listFilter, loadList,
        createForm, creating, createError, createTotal,
        addItem, removeItem, onPickFiles, removeAttachment, submitCreate,
        detail, approving, paying, cancelling,
        approvalForm, paymentForm,
        isMine, canApprove, canCancel,
        doApprove, doPay, doCancel, downloadAttachment,
        statusText, money, fileSize, fmtTime, goDetail
      };
    }
  }).mount('#app');
})();
