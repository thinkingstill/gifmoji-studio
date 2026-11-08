const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  config: {
    managedKey: false,
    model: 'hy-image-v3.5-preview',
    defaultModel: 'hy-image-v3.5-preview',
    defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation',
    defaultProtocol: 'hunyuan',
    maxFrames: 8
  },
  referenceFile: null,
  referenceUrl: '',
  sessionId: '',
  frames: [],
  frameCount: 6,
  generating: false,
  jobId: '',
  gif: null,
  composing: false
};

const els = {
  referenceInput: $('#reference-input'),
  dropzone: $('#dropzone'),
  referencePreview: $('#reference-preview'),
  referenceImage: $('#reference-image'),
  referenceName: $('#reference-name'),
  removeReference: $('#remove-reference'),
  prompt: $('#prompt-input'),
  promptCount: $('#prompt-count'),
  style: $('#style-select'),
  motion: $('#motion-select'),
  frameBadge: $('#frame-badge'),
  generate: $('#generate-button'),
  generateTitle: $('#generate-button strong'),
  generateHint: $('#generate-hint'),
  createError: $('#create-error'),
  keyBox: $('#key-box'),
  apiKey: $('#api-key'),
  rememberKey: $('#remember-key'),
  keyState: $('#key-state'),
  toggleKey: $('#toggle-key'),
  baseUrl: $('#base-url'),
  modelInput: $('#model-input'),
  protocolSelect: $('#protocol-select'),
  configHelp: $('#config-help'),
  resetModel: $('#reset-model'),
  stageEmpty: $('#stage-empty'),
  stageProgress: $('#stage-progress'),
  progressFill: $('#progress-fill'),
  progressNumber: $('#progress-number'),
  progressMessage: $('#progress-message'),
  progressDetail: $('#progress-detail'),
  frameGrid: $('#frame-grid'),
  stageFooter: $('#stage-footer'),
  importInput: $('#import-frames'),
  gifPreview: $('#gif-preview'),
  gifPlaceholder: $('#gif-placeholder'),
  gifImage: $('#gif-image'),
  gifSize: $('#gif-size'),
  gifBadge: $('.gif-badge'),
  compose: $('#compose-button'),
  exportError: $('#export-error'),
  exportActions: $('#export-actions'),
  downloadGif: $('#download-gif'),
  downloadMeta: $('#download-meta'),
  downloadFrames: $('#download-frames'),
  maxSize: $('#max-size'),
  limitToggle: $('#limit-toggle'),
  limitInput: $('#limit-input'),
  toast: $('#toast')
};

let toastTimer;
function toast(message, type = '') {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast show ${type}`;
  toastTimer = setTimeout(() => { els.toast.className = 'toast'; }, 3000);
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.hidden = true;
  element.textContent = '';
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : {};
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.code = data.code || '';
    error.status = response.status;
    throw error;
  }
  return data;
}

function getApiKey() {
  return els.apiKey.value.trim();
}

function sameEndpoint(left, right) {
  return left.trim().replace(/\/+$/, '') === right.trim().replace(/\/+$/, '');
}

function usingDefaultEndpoint() {
  return sameEndpoint(els.baseUrl.value, state.config.defaultBaseUrl)
    && els.protocolSelect.value === 'hunyuan';
}

function hasUsableKey() {
  return Boolean(getApiKey()) || (state.config.managedKey && usingDefaultEndpoint());
}

function currentModel() {
  return els.modelInput.value.trim() || state.config.defaultModel;
}

function saveModelSettings() {
  try {
    localStorage.setItem('gifmoji-model-settings', JSON.stringify({
      baseUrl: els.baseUrl.value.trim(),
      model: els.modelInput.value.trim(),
      protocol: els.protocolSelect.value
    }));
  } catch {
    // 浏览器隐私模式可能禁用本地存储，不影响本次使用
  }
}

function applyModelPreset(preset) {
  els.apiKey.value = '';
  els.rememberKey.checked = false;
  sessionStorage.removeItem('gifmoji-key');
  els.apiKey.type = 'password';
  els.toggleKey.textContent = '显示';
  if (preset === 'hunyuan') {
    els.baseUrl.value = state.config.defaultBaseUrl;
    els.modelInput.value = state.config.defaultModel;
    els.protocolSelect.value = state.config.defaultProtocol || 'hunyuan';
  } else {
    els.baseUrl.value = '';
    els.modelInput.value = '';
    els.protocolSelect.value = 'auto';
  }
  $$('.provider-preset').forEach((button) => button.classList.toggle('active', button.dataset.preset === preset));
  saveModelSettings();
  updateKeyState();
  if (preset === 'custom') els.baseUrl.focus();
}

function updatePresetState() {
  const isDefault = usingDefaultEndpoint()
    && els.modelInput.value.trim() === state.config.defaultModel;
  $$('.provider-preset').forEach((button) => {
    button.classList.toggle('active', button.dataset.preset === (isDefault ? 'hunyuan' : 'custom'));
  });
}

function protocolHint(protocol) {
  if (protocol === 'hunyuan') return '混元协议：POST 到 v35-generation，使用 messages 与 image_url，支持参考图和多轮编辑。';
  if (protocol === 'openai-images') return '图像协议：无参考图调用 /images/generations；有参考图调用 /images/edits 并上传图片。';
  if (protocol === 'openai-chat') return '聊天协议：调用 /chat/completions，模型需支持图片输出；参考图会作为 image_url 传入。';
  return '自动识别：根据地址中的 hunyuan-image、images 或 chat/completions 选择请求格式。';
}

function updateKeyState() {
  const managedAvailable = state.config.managedKey && usingDefaultEndpoint();
  const hasKey = Boolean(getApiKey());
  const isDefault = usingDefaultEndpoint();
  let label;
  if (managedAvailable) label = '平台密钥';
  else if (isDefault) label = hasKey ? '默认 · 已填写' : '默认 · 待填写';
  else label = hasKey ? '自定义 · 已填写' : '自定义 · 待填写';
  els.keyState.textContent = label;
  els.keyState.classList.toggle('ready', managedAvailable || hasKey);
  els.apiKey.placeholder = managedAvailable ? '平台已配置，可留空' : 'sk-...';
  els.configHelp.textContent = protocolHint(els.protocolSelect.value);
  els.configHelp.title = '平台配置的密钥只会发送到默认 TokenHub 地址，自定义接口必须填写自己的密钥。';
  updatePresetState();
  els.generateHint.textContent = `${currentModel()} · ${state.frameCount} 次调用`;
}

async function loadConfig() {
  try {
    state.config = { ...state.config, ...(await request('/api/config')) };
  } catch {
    // 保留默认值，提交时仍会显示具体错误
  }
  els.baseUrl.value = state.config.defaultBaseUrl;
  els.modelInput.value = state.config.defaultModel;
  els.protocolSelect.value = state.config.defaultProtocol || 'hunyuan';
  try {
    const saved = JSON.parse(localStorage.getItem('gifmoji-model-settings') || 'null');
    if (saved && typeof saved.baseUrl === 'string' && typeof saved.model === 'string') {
      els.baseUrl.value = saved.baseUrl;
      els.modelInput.value = saved.model;
      els.protocolSelect.value = saved.protocol || 'auto';
    }
  } catch {
    // 忽略损坏的本地配置
  }
  updateKeyState();
}

function setReference(file) {
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    showError(els.createError, '参考图仅支持 JPG、PNG 或 WebP。');
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showError(els.createError, '参考图不能超过 15 MB。');
    return;
  }
  if (state.referenceUrl) URL.revokeObjectURL(state.referenceUrl);
  state.referenceFile = file;
  state.referenceUrl = URL.createObjectURL(file);
  els.referenceImage.src = state.referenceUrl;
  els.referenceName.textContent = `${file.name} · ${humanSize(file.size)}`;
  els.referencePreview.hidden = false;
  els.dropzone.hidden = true;
  clearError(els.createError);
}

function removeReference() {
  if (state.referenceUrl) URL.revokeObjectURL(state.referenceUrl);
  state.referenceFile = null;
  state.referenceUrl = '';
  els.referenceInput.value = '';
  els.referenceImage.removeAttribute('src');
  els.referencePreview.hidden = true;
  els.dropzone.hidden = false;
}

function setupUpload() {
  els.dropzone.addEventListener('click', () => els.referenceInput.click());
  els.referenceInput.addEventListener('change', () => setReference(els.referenceInput.files?.[0]));
  els.removeReference.addEventListener('click', removeReference);

  ['dragenter', 'dragover'].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove('dragover');
    });
  });
  els.dropzone.addEventListener('drop', (event) => {
    setReference(event.dataTransfer?.files?.[0]);
  });
}

function setupPrompt() {
  const updateCount = () => {
    els.promptCount.textContent = `${els.prompt.value.length} / 2000`;
  };
  els.prompt.addEventListener('input', updateCount);
  $$('.prompt-chips button').forEach((button) => {
    button.addEventListener('click', () => {
      els.prompt.value = button.dataset.prompt || '';
      els.prompt.focus();
      updateCount();
    });
  });
  updateCount();
}

function setupFrameCount() {
  $$('#frame-count button').forEach((button) => {
    button.addEventListener('click', () => {
      $$('#frame-count button').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      state.frameCount = Number(button.dataset.value);
      updateKeyState();
    });
  });
}

function setupKey() {
  els.apiKey.addEventListener('input', () => {
    if (els.rememberKey.checked) sessionStorage.setItem('gifmoji-key', els.apiKey.value);
    updateKeyState();
  });
  els.rememberKey.addEventListener('change', () => {
    if (els.rememberKey.checked) sessionStorage.setItem('gifmoji-key', els.apiKey.value);
    else sessionStorage.removeItem('gifmoji-key');
  });
  els.toggleKey.addEventListener('click', () => {
    const show = els.apiKey.type === 'password';
    els.apiKey.type = show ? 'text' : 'password';
    els.toggleKey.textContent = show ? '隐藏' : '显示';
  });
  $$('.provider-preset').forEach((button) => {
    button.addEventListener('click', () => applyModelPreset(button.dataset.preset));
  });
  els.resetModel.addEventListener('click', () => applyModelPreset('hunyuan'));
  [els.baseUrl, els.modelInput, els.protocolSelect].forEach((input) => {
    input.addEventListener('input', () => {
      saveModelSettings();
      updateKeyState();
    });
    input.addEventListener('change', updateKeyState);
  });
  const remembered = sessionStorage.getItem('gifmoji-key');
  if (remembered) {
    els.apiKey.value = remembered;
    els.rememberKey.checked = true;
  }
}

function setGenerating(generating) {
  state.generating = generating;
  els.generate.disabled = generating;
  els.generateTitle.textContent = generating ? '正在生成分镜…' : '开始生成分镜';
  els.generateHint.textContent = generating ? '请保持页面打开' : `${currentModel()} · ${state.frameCount} 次调用`;
}

function showProgress(progress) {
  els.stageEmpty.hidden = true;
  els.stageProgress.hidden = false;
  const value = Math.max(0, Math.min(100, Number(progress.progress) || 0));
  els.progressFill.style.width = `${value}%`;
  els.progressNumber.textContent = `${value}%`;
  els.progressMessage.textContent = progress.message || '正在生成…';
  els.progressDetail.textContent = `第 ${progress.current || 0} / ${progress.total || state.frameCount} 帧`;
}

function hideProgress() {
  els.stageProgress.hidden = true;
}

function resetGif() {
  state.gif = null;
  els.gifImage.hidden = true;
  els.gifImage.removeAttribute('src');
  els.gifPlaceholder.hidden = false;
  els.gifSize.hidden = true;
  els.exportActions.hidden = true;
  els.downloadGif.href = '#';
  els.downloadFrames.href = state.sessionId ? `/api/download/${state.sessionId}/frames.zip` : '#';
  $('#wechat-download').href = '#';
  updateComposeState();
}

function updateComposeState() {
  els.compose.disabled = state.composing || state.frames.length < 2;
}

function applySession(session) {
  if (!session) return;
  state.sessionId = session.id;
  state.frames = session.frames || [];
  state.sessionId = session.id;
  renderFrames();
  els.downloadFrames.href = `/api/download/${session.id}/frames.zip`;
}

function renderFrames() {
  els.frameGrid.replaceChildren();
  els.frameBadge.textContent = `${state.frames.length} 帧`;
  els.stageFooter.hidden = state.frames.length === 0;
  els.stageEmpty.hidden = state.frames.length > 0 || state.generating;
  els.frameGrid.hidden = state.frames.length === 0;

  state.frames.forEach((frame, index) => {
    const card = document.createElement('article');
    card.className = 'frame-card';
    card.draggable = true;
    card.dataset.id = frame.id;
    card.setAttribute('aria-label', `第 ${index + 1} 帧，${frame.caption || '分镜'}`);

    const image = document.createElement('img');
    image.src = frame.url;
    image.alt = `分镜 ${index + 1}：${frame.caption || '角色动作'}`;
    image.loading = index > 2 ? 'lazy' : 'eager';
    card.appendChild(image);

    const top = document.createElement('div');
    top.className = 'frame-top';
    const number = document.createElement('span');
    number.className = 'frame-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'frame-remove';
    remove.setAttribute('aria-label', `删除第 ${index + 1} 帧`);
    remove.innerHTML = '<svg><use href="#i-x"/></svg>';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteFrame(frame.id);
    });
    top.append(number, remove);
    card.appendChild(top);

    const bottom = document.createElement('div');
    bottom.className = 'frame-bottom';
    const caption = document.createElement('span');
    caption.className = 'frame-caption';
    caption.textContent = frame.caption || '分镜';
    const handle = document.createElement('span');
    handle.className = 'frame-handle';
    handle.textContent = '⠿';
    bottom.append(caption, handle);
    card.appendChild(bottom);

    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', frame.id);
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('.frame-card').forEach((item) => item.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('drag-over');
      const draggedId = event.dataTransfer.getData('text/plain');
      reorderFrame(draggedId, frame.id);
    });

    els.frameGrid.appendChild(card);
  });

  if (state.sessionId) {
    els.downloadFrames.href = `/api/download/${state.sessionId}/frames.zip`;
  }
  updateComposeState();
}

function reorderFrame(draggedId, targetId) {
  if (!draggedId || draggedId === targetId) return;
  const from = state.frames.findIndex((item) => item.id === draggedId);
  const to = state.frames.findIndex((item) => item.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = state.frames.splice(from, 1);
  state.frames.splice(to, 0, moved);
  resetGif();
  renderFrames();
}

async function deleteFrame(frameId) {
  if (!state.sessionId) return;
  try {
    const data = await request(`/api/frames/${state.sessionId}/${frameId}`, { method: 'DELETE' });
    state.frames = data.session.frames;
    resetGif();
    renderFrames();
    toast('已移除这一帧');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function pollJob(jobId) {
  const startedAt = Date.now();
  let failures = 0;
  while (state.jobId === jobId) {
    if (Date.now() - startedAt > 20 * 60 * 1000) {
      throw new Error('生成等待超时，请稍后重新尝试。');
    }
    let data;
    try {
      data = await request(`/api/jobs/${jobId}`);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    applySession(data.session);
    showProgress(data);

    if (data.status === 'done') {
      setGenerating(false);
      hideProgress();
      toast(`分镜完成，共 ${state.frames.length} 帧`);
      return;
    }
    if (data.status === 'error') {
      throw new Error(data.message || '生成失败，请重试。');
    }
    await new Promise((resolve) => setTimeout(resolve, 1300));
  }
}

async function startGeneration() {
  clearError(els.createError);
  const prompt = els.prompt.value.trim();
  if (prompt.length < 2) {
    showError(els.createError, '先描述一下它现在是什么反应。');
    els.prompt.focus();
    return;
  }
  if (!els.baseUrl.value.trim()) {
    showError(els.createError, '请填写模型接口的 Base URL。');
    els.keyBox.open = true;
    els.baseUrl.focus();
    return;
  }
  try {
    const endpoint = new URL(els.baseUrl.value.trim());
    const isLocalHttp = endpoint.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !isLocalHttp) throw new Error();
  } catch {
    showError(els.createError, 'Base URL 必须是完整的 HTTPS 地址。');
    els.keyBox.open = true;
    els.baseUrl.focus();
    return;
  }
  if (!els.modelInput.value.trim()) {
    showError(els.createError, '请填写模型 ID。');
    els.keyBox.open = true;
    els.modelInput.focus();
    return;
  }
  if (!hasUsableKey()) {
    showError(els.createError, '请填写接口 API Key。平台密钥只适用于默认 TokenHub 接口。');
    els.keyBox.open = true;
    els.apiKey.focus();
    return;
  }

  resetGif();
  state.frames = [];
  state.sessionId = '';
  renderFrames();
  setGenerating(true);
  showProgress({ progress: 2, current: 0, total: state.frameCount, message: `正在提交到 ${currentModel()}…` });

  const form = new FormData();
  if (state.referenceFile) form.append('reference', state.referenceFile);
  form.append('prompt', prompt);
  form.append('style', els.style.value);
  form.append('motion', els.motion.value);
  form.append('frameCount', String(state.frameCount));
  form.append('baseUrl', els.baseUrl.value.trim());
  form.append('model', els.modelInput.value.trim());
  form.append('protocol', els.protocolSelect.value);
  if (getApiKey()) form.append('apiKey', getApiKey());

  try {
    const data = await request('/api/generate', { method: 'POST', body: form });
    state.jobId = data.jobId;
    state.sessionId = data.sessionId;
    await pollJob(data.jobId);
  } catch (error) {
    setGenerating(false);
    hideProgress();
    if (!state.frames.length) els.stageEmpty.hidden = false;
    showError(els.createError, error.message);
    toast(error.message, 'error');
  }
}

function setupGenerate() {
  els.generate.addEventListener('click', startGeneration);
  window.addEventListener('beforeunload', (event) => {
    if (!state.generating) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

async function importFrames(files) {
  if (!files?.length) return;
  const form = new FormData();
  if (state.sessionId) form.append('sessionId', state.sessionId);
  Array.from(files).slice(0, 8).forEach((file) => form.append('frames', file));
  try {
    const data = await request('/api/import', { method: 'POST', body: form });
    applySession(data.session);
    resetGif();
    renderFrames();
    toast(`已导入 ${files.length} 张分镜`);
  } catch (error) {
    showError(els.createError, error.message);
    toast(error.message, 'error');
  }
}

function setupImport() {
  const trigger = () => els.importInput.click();
  $('#import-button').addEventListener('click', trigger);
  $('#empty-import').addEventListener('click', trigger);
  els.importInput.addEventListener('change', () => {
    importFrames(els.importInput.files);
    els.importInput.value = '';
  });
  $('#clear-frames').addEventListener('click', async () => {
    if (!state.sessionId || !state.frames.length) return;
    try {
      await Promise.all(state.frames.map((frame) => request(`/api/frames/${state.sessionId}/${frame.id}`, { method: 'DELETE' })));
      state.frames = [];
      resetGif();
      renderFrames();
      toast('分镜台已清空');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function setupOptions() {
  $$('#size-options button').forEach((button) => {
    button.addEventListener('click', () => {
      $$('#size-options button').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      resetGif();
    });
  });
  $$('#quality-options button').forEach((button) => {
    button.addEventListener('click', () => {
      $$('#quality-options button').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      resetGif();
    });
  });
  els.limitToggle.addEventListener('change', () => {
    els.limitInput.hidden = !els.limitToggle.checked;
    resetGif();
  });
  $('#pace-select').addEventListener('change', resetGif);
  $('#fps-select').addEventListener('change', resetGif);
}

async function composeGif() {
  clearError(els.exportError);
  if (state.frames.length < 2) {
    showError(els.exportError, '至少需要两帧才能合成动态 GIF。');
    return;
  }
  state.composing = true;
  updateComposeState();
  els.compose.querySelector('span').textContent = '正在合成与压缩…';
  els.compose.querySelector('small').textContent = 'PROCESSING';

  const width = Number($('#size-options .active')?.dataset.value || 240);
  const quality = $('#quality-options .active')?.dataset.value || 'high';
  const body = {
    sessionId: state.sessionId,
    order: state.frames.map((frame) => frame.id),
    width,
    quality,
    fps: Number($('#fps-select').value),
    holdMs: Number($('#pace-select').value),
    maxMb: els.limitToggle.checked ? Number(els.maxSize.value) : null
  };

  try {
    const data = await request('/api/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    state.gif = data.gif;
    els.gifPlaceholder.hidden = true;
    els.gifImage.src = data.gif.url;
    els.gifImage.hidden = false;
    els.gifSize.textContent = `${data.gif.width}×${data.gif.height} · ${humanSize(data.gif.bytes)}`;
    els.gifSize.hidden = false;
    els.exportActions.hidden = false;
    els.downloadGif.href = data.gif.downloadUrl;
    els.downloadMeta.textContent = `${humanSize(data.gif.bytes)} · ${data.gif.pages || state.frames.length} 帧`;
    els.downloadFrames.href = `/api/download/${state.sessionId}/frames.zip`;
    $('#wechat-download').href = data.gif.downloadUrl;
    if (data.gif.underLimit === false) {
      showError(els.exportError, '已尝试压缩，但仍略高于目标体积。可改用 240px 或轻量画质。');
    } else {
      toast(`GIF 合成完成 · ${humanSize(data.gif.bytes)}`);
    }
  } catch (error) {
    showError(els.exportError, error.message);
    toast(error.message, 'error');
  } finally {
    state.composing = false;
    els.compose.querySelector('span').textContent = '合成 GIF';
    els.compose.querySelector('small').textContent = 'FFMPEG 本地渲染';
    updateComposeState();
  }
}

function setupCompose() {
  els.compose.addEventListener('click', composeGif);
  els.maxSize.addEventListener('input', resetGif);
}

function setupModals() {
  const openModal = (modal) => {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const close = modal.querySelector('.modal-close');
    if (close) close.focus();
  };
  const closeModal = (modal) => {
    modal.hidden = true;
    document.body.style.overflow = '';
  };

  $('#help-button').addEventListener('click', () => openModal($('#help-modal')));
  $('#wechat-button').addEventListener('click', () => openModal($('#wechat-modal')));
  $$('.modal').forEach((modal) => {
    $$('[data-close]', modal).forEach((button) => button.addEventListener('click', () => closeModal(modal)));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    $$('.modal:not([hidden])').forEach(closeModal);
  });
  $('#wechat-download').addEventListener('click', (event) => {
    if (!state.gif) {
      event.preventDefault();
      toast('请先在右侧合成 GIF', 'error');
    }
  });
}

function init() {
  setupUpload();
  setupPrompt();
  setupFrameCount();
  setupKey();
  setupGenerate();
  setupImport();
  setupOptions();
  setupCompose();
  setupModals();
  loadConfig();
  renderFrames();
  resetGif();
}

init();
