(function () {
  const data = Array.isArray(window.MEETING_DATA) ? window.MEETING_DATA : [];
  const PAGE_SIZE = 14;
  const customerFilter = document.querySelector('#customerFilter');
  const customerList = document.querySelector('#customerList');
  const monthFilter = document.querySelector('#monthFilter');
  const productFilter = document.querySelector('#productFilter');
  const meetingFilter = document.querySelector('#meetingFilter');
  const filterForm = document.querySelector('#filterForm');
  const resetButton = document.querySelector('#resetButton');
  const resultList = document.querySelector('#resultList');
  const emptyState = document.querySelector('#emptyState');
  const activeFilters = document.querySelector('#activeFilters');
  const loadMoreButton = document.querySelector('#loadMoreButton');
  const template = document.querySelector('#customerTemplate');
  const sourceNote = document.querySelector('#sourceNote');
  const statusToast = document.querySelector('#statusToast');
  const collator = new Intl.Collator('zh-CN');

  let currentCustomers = [];
  let currentMeetingCount = 0;
  let visibleCount = PAGE_SIZE;
  let paymentState = 'loading';
  let toastTimer;
  const paidRecordIds = new Set();

  const unique = (items) => [...new Set(items.filter(Boolean))];
  const display = (value) => value || '未填写';
  const meetingKey = (record) => `${record.date}|${record.meeting}|${record.product}`;
  const customerMeetingKey = (record) => record.paymentId;
  const roleClass = (role) => {
    if (role === '主席') return 'role-chair';
    if (role === '讲者' || role === '讲课') return 'role-speaker';
    if (role === '讨论') return 'role-discussion';
    if (role === '主持') return 'role-host';
    return 'role-missing';
  };

  const availableMonths = (() => {
    const dates = data.map((row) => row.date).sort();
    if (!dates.length) return [];
    const start = new Date(`${dates[0].slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(`${dates.at(-1).slice(0, 7)}-01T00:00:00Z`);
    const months = [];
    for (const cursor = new Date(start); cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) months.push(cursor.toISOString().slice(0, 7));
    return months;
  })();

  for (const customer of unique(data.map((row) => row.customer)).sort(collator.compare)) {
    const option = document.createElement('option');
    option.value = customer;
    customerList.append(option);
  }
  for (const month of availableMonths) {
    const option = document.createElement('option');
    option.value = month;
    option.textContent = `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
    monthFilter.append(option);
  }
  for (const product of unique(data.map((row) => row.product)).sort(collator.compare)) {
    const option = document.createElement('option');
    option.value = product;
    option.textContent = product;
    productFilter.append(option);
  }
  for (const meeting of unique(data.map((row) => row.meeting)).sort(collator.compare)) {
    const option = document.createElement('option');
    option.value = meeting;
    option.textContent = meeting;
    meetingFilter.append(option);
  }

  const getFilterValues = () => ({
    customer: customerFilter.value.trim(),
    month: monthFilter.value,
    product: productFilter.value,
    meeting: meetingFilter.value,
  });

  const getMatchingRecords = ({ customer, month, product, meeting }) => {
    const normalizedCustomer = customer.toLocaleLowerCase('zh-CN');
    return data.filter((record) => {
      const customerMatch = !normalizedCustomer || record.customer.toLocaleLowerCase('zh-CN').includes(normalizedCustomer);
      const monthMatch = !month || record.date.startsWith(month);
      const productMatch = !product || record.product === product;
      const meetingMatch = !meeting || record.meeting === meeting;
      return customerMatch && monthMatch && productMatch && meetingMatch;
    });
  };

  const groupByCustomer = (records) => {
    const map = new Map();
    for (const record of records) {
      const customer = record.customer || '未填写客户';
      if (!map.has(customer)) map.set(customer, []);
      map.get(customer).push(record);
    }
    return [...map.entries()].map(([customer, customerRecords]) => ({
      customer,
      records: customerRecords.sort((a, b) => b.date.localeCompare(a.date) || collator.compare(a.meeting, b.meeting)),
      meetingCount: new Set(customerRecords.map(meetingKey)).size,
    })).sort((a, b) => b.meetingCount - a.meetingCount || b.records.length - a.records.length || collator.compare(a.customer, b.customer));
  };

  const updateSummary = (records, filters) => {
    currentMeetingCount = new Set(records.map(meetingKey)).size;
    const namedCustomerCount = currentCustomers.filter((item) => item.customer !== '未填写客户').length;
    const missingCustomerRecords = records.filter((record) => !record.customer).length;
    document.querySelector('#customerCount').textContent = namedCustomerCount;
    document.querySelector('#meetingCount').textContent = currentMeetingCount;
    document.querySelector('#recordCount').textContent = records.length;
    document.querySelector('#tamCount').textContent = unique(records.map((row) => row.tam)).length;
    document.querySelector('#resultSummary').textContent = `找到 ${namedCustomerCount} 位客户，涉及 ${currentMeetingCount} 个会议场次${missingCustomerRecords ? `；${missingCustomerRecords} 条客户未填写` : ''}`;

    activeFilters.replaceChildren();
    const tokens = [
      filters.customer && `客户：${filters.customer}`,
      filters.month && `${filters.month.slice(0, 4)}年${Number(filters.month.slice(5, 7))}月`,
      filters.product && `产品：${filters.product}`,
      filters.meeting && `会议：${filters.meeting}`,
    ].filter(Boolean);
    for (const token of tokens) {
      const span = document.createElement('span');
      span.className = 'filter-token';
      span.textContent = token;
      activeFilters.append(span);
    }
  };

  const showToast = (message, isError = false) => {
    window.clearTimeout(toastTimer);
    statusToast.textContent = message;
    statusToast.classList.toggle('is-error', isError);
    statusToast.hidden = false;
    toastTimer = window.setTimeout(() => { statusToast.hidden = true; }, 3200);
  };

  const setPaymentButtonState = (button, record, { busy = false } = {}) => {
    const isPaid = paidRecordIds.has(record.paymentId);
    button.classList.toggle('is-paid', isPaid);
    button.setAttribute('aria-pressed', String(isPaid));
    if (busy) {
      button.disabled = true;
      button.textContent = '保存中…';
      return;
    }
    if (paymentState === 'loading') {
      button.disabled = true;
      button.textContent = '读取中…';
      return;
    }
    if (paymentState === 'error') {
      button.disabled = true;
      button.textContent = '状态不可用';
      return;
    }
    button.disabled = false;
    button.textContent = isPaid ? '讲课费已打' : '标记已打';
    button.title = isPaid ? '点击可取消“讲课费已打”状态' : '点击标记讲课费已打';
  };

  const savePaymentStatus = async (button, record) => {
    const nextPaid = !paidRecordIds.has(record.paymentId);
    setPaymentButtonState(button, record, { busy: true });
    try {
      const response = await fetch('/api/payment-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordId: record.paymentId, paid: nextPaid }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '保存失败');
      if (nextPaid) paidRecordIds.add(record.paymentId); else paidRecordIds.delete(record.paymentId);
      setPaymentButtonState(button, record);
      showToast(nextPaid ? `已标记：${record.customer || '未填写客户'}的讲课费已打` : `已取消：${record.customer || '未填写客户'}的讲课费状态`);
    } catch (error) {
      setPaymentButtonState(button, record);
      showToast(error?.message || '付款状态保存失败，请重试。', true);
    }
  };

  const buildMeetingRow = (record) => {
    const row = document.createElement('div');
    row.className = 'meeting-row';
    row.setAttribute('role', 'row');
    const values = [record.date, display(record.meeting), display(record.product), display(record.group), display(record.role), display(record.tam)];
    values.forEach((value, index) => {
      const cell = document.createElement('span');
      cell.setAttribute('role', 'cell');
      cell.textContent = value;
      if (index === 4) cell.className = `role-badge ${roleClass(record.role)}`;
      row.append(cell);
    });
    const paymentCell = document.createElement('span');
    paymentCell.className = 'payment-cell';
    paymentCell.setAttribute('role', 'cell');
    const paymentButton = document.createElement('button');
    paymentButton.type = 'button';
    paymentButton.className = 'payment-button';
    paymentButton.setAttribute('aria-label', `${record.customer || '未填写客户'} ${record.date} ${record.meeting}讲课费状态`);
    setPaymentButtonState(paymentButton, record);
    paymentButton.addEventListener('click', () => savePaymentStatus(paymentButton, record));
    paymentCell.append(paymentButton);
    row.append(paymentCell);
    return row;
  };

  const buildCustomerCard = (item) => {
    const card = template.content.firstElementChild.cloneNode(true);
    const groups = unique(item.records.map((row) => row.group));
    const products = unique(item.records.map((row) => row.product));
    const tams = unique(item.records.map((row) => row.tam));
    const roles = item.records.reduce((map, row) => map.set(display(row.role), (map.get(display(row.role)) || 0) + 1), new Map());

    card.querySelector('.customer-avatar').textContent = item.customer === '未填写客户' ? '—' : item.customer.slice(0, 1);
    card.querySelector('h3').textContent = item.customer;
    card.querySelector('.customer-meta').textContent = `${item.meetingCount} 个会议场次 · 产品：${products.join('、') || '未填写'} · 治疗组：${groups.join('、') || '未填写'} · TAM：${tams.join('、') || '未填写'}`;
    const detailAction = card.querySelector('.detail-action');
    card.querySelector('details').addEventListener('toggle', (event) => {
      detailAction.textContent = event.currentTarget.open ? '收起会议' : '查看会议';
    });

    const roleSummary = card.querySelector('.role-summary');
    for (const [role, count] of roles) {
      const pill = document.createElement('span');
      pill.className = 'role-pill';
      pill.textContent = `${role} ${count}`;
      roleSummary.append(pill);
    }

    const body = card.querySelector('.meeting-body');
    const uniqueMeetingRecords = [...new Map(item.records.map((record) => [customerMeetingKey(record), record])).values()];
    for (const record of uniqueMeetingRecords) body.append(buildMeetingRow(record));
    return card;
  };

  const renderList = () => {
    resultList.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of currentCustomers.slice(0, visibleCount)) fragment.append(buildCustomerCard(item));
    resultList.append(fragment);
    const shown = Math.min(visibleCount, currentCustomers.length);
    loadMoreButton.hidden = shown >= currentCustomers.length;
    if (!loadMoreButton.hidden) loadMoreButton.textContent = `加载更多结果（已显示 ${shown}/${currentCustomers.length}）`;
  };

  const applyFilters = ({ resetPage = true } = {}) => {
    const filters = getFilterValues();
    const records = getMatchingRecords(filters);
    currentCustomers = groupByCustomer(records);
    if (resetPage) visibleCount = PAGE_SIZE;
    updateSummary(records, filters);
    emptyState.hidden = currentCustomers.length !== 0;
    resultList.hidden = currentCustomers.length === 0;
    renderList();
    return {
      customerCount: currentCustomers.filter((item) => item.customer !== '未填写客户').length,
      meetingCount: currentMeetingCount,
      missingCustomerRecords: getMatchingRecords(getFilterValues()).filter((record) => !record.customer).length,
      customers: currentCustomers.slice(0, 10).map(({ customer, meetingCount }) => ({ customer, meetingCount })),
    };
  };

  const loadPaymentStatuses = async () => {
    try {
      const response = await fetch('/api/payment-status', { headers: { accept: 'application/json' } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(result.paidRecordIds)) throw new Error(result.error || '付款状态读取失败');
      paidRecordIds.clear();
      for (const recordId of result.paidRecordIds) paidRecordIds.add(recordId);
      paymentState = 'ready';
    } catch (error) {
      paymentState = 'error';
      showToast(error?.message || '付款状态暂时无法读取。', true);
    }
    renderList();
  };

  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    applyFilters();
  });
  for (const control of [monthFilter, productFilter, meetingFilter, customerFilter]) control.addEventListener('change', () => applyFilters());
  resetButton.addEventListener('click', () => {
    filterForm.reset();
    applyFilters();
    customerFilter.focus();
  });
  loadMoreButton.addEventListener('click', () => {
    visibleCount += PAGE_SIZE;
    renderList();
  });

  const registerWebMcp = () => {
    const context = typeof document === 'undefined' ? undefined : document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const knownProducts = new Set(unique(data.map((row) => row.product)));
    const knownMeetings = new Set(unique(data.map((row) => row.meeting)));
    try {
      void Promise.resolve(context.registerTool({
        name: 'search_customer_meetings',
        title: '查询客户会议覆盖',
        description: '按客户、月份、产品和会议名称筛选，并以客户为主更新覆盖结果。所有条件均为可选。',
        inputSchema: {
          type: 'object',
          properties: {
            customer: { type: 'string', description: '客户全名或姓名片段。' },
            month: { type: 'string', description: '月份，格式为 YYYY-MM，例如 2026-09。' },
            product: { type: 'string', description: '产品名称。' },
            meeting: { type: 'string', description: '会议名称。' },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute(input) {
          const next = input && typeof input === 'object' ? input : {};
          const customer = typeof next.customer === 'string' ? next.customer.trim() : '';
          const month = typeof next.month === 'string' ? next.month.trim() : '';
          const product = typeof next.product === 'string' ? next.product.trim() : '';
          const meeting = typeof next.meeting === 'string' ? next.meeting.trim() : '';
          if (customer.length > 50) throw new Error('客户名称过长。');
          if (month && !availableMonths.includes(month)) throw new Error('月份不在可查询范围内。');
          if (product && !knownProducts.has(product)) throw new Error('产品名称不存在。');
          if (meeting && !knownMeetings.has(meeting)) throw new Error('会议名称不存在。');
          customerFilter.value = customer;
          monthFilter.value = month;
          productFilter.value = product;
          meetingFilter.value = meeting;
          return applyFilters();
        },
      }, { signal: lifecycle.signal })).catch(() => {});
    } catch (_) {}
    window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  };

  const missingCustomerRecords = data.filter((record) => !record.customer).length;
  sourceNote.textContent = `数据源：2026-Q1 会议覆盖明细，共 ${data.length} 条参与记录。结果按客户聚合，会议场次按“时间 + 会议名称 + 产品”去重${missingCustomerRecords ? `；${missingCustomerRecords} 条客户空白记录单独标示` : ''}。`;
  applyFilters();
  loadPaymentStatuses();
  registerWebMcp();
})();
