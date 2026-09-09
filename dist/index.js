/*
SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright (c) 2026 huayueshan
https://polyformproject.org/licenses/noncommercial/1.0.0
*/
(() => {
  'use strict';

  const PATCH_NAME = '数据库三层绑定补丁';
  const PATCH_VERSION = '1.7.11-dev.1';
  const PATCH_NAMESPACE = 'shujuku_scope_binding_patch_v1';
  const CHAT_META_KEY = 'ShujukuScopeBindingPatchV1';
  const CHARACTER_META_KEY = 'ShujukuScopeBindingCharacterV1';
  const EMBEDDED_TABLE_PRESET_SCHEMA = 'shujuku-table-template';
  // shujuku does not expose a public settings mutation API. Keep its private
  // storage and DOM compatibility surface centralized for upstream upgrades.
  const DB_STORAGE_CONTRACT = Object.freeze({
    settingsNamespace: 'shujuku_v120__userscript_settings_v1',
    globalMetaKey: 'shujuku_v120_globalMeta_v1',
    profilePrefix: 'shujuku_v120_profile_v1',
  });
  const DB_UI_CONTRACT = Object.freeze({
    rootId: 'acu-app-v2',
    tablePage: '.acu-v2-table-page',
    templatePanel: '#form-fill-template-panel',
    plotPage: '.acu-v2-plot-page',
    sourcePicker: '.acu-v2-wb-source-picker',
    entryPicker: '.acu-v2-wb-entry-picker',
    entryHintStrong: '.acu-v2-wb-entry-picker__hint strong',
    sidebarItem: '.acu-v2-sidebar__item',
    sidebarActive: '.acu-v2-sidebar__item--active',
    segmentedItem: '.acu-segmented__item',
    injectionTrigger: '#table-injection-target-panel .acu-select__trigger',
    injectionOption: '#table-injection-target-panel .acu-select__item',
    menuControls: '#acu-v2-menu-item, #acu-btn-open-editor, button',
    menuItemId: 'acu-v2-menu-item',
    openEditorId: 'acu-btn-open-editor',
    labels: Object.freeze({
      table: '填表规则',
      formFill: '填表工作台',
      plot: '剧情推进',
      manual: '手动选择',
      open: '打开数据库',
      characterTarget: '角色卡绑定世界书',
    }),
  });
  const RUNTIME_KEY = '__SHUJUKU_SCOPE_BINDING_PATCH_V1__';
  const TEST_KEY = '__SHUJUKU_SCOPE_BINDING_PATCH_TEST__';
  const FEATURE_IDS = [
    'writeWorldbook',
    'tableWorldbooks',
    'plotWorldbooks',
    'plotPreset',
    'tablePreset',
  ];
  const SCOPE_IDS = ['global', 'character', 'chat'];
  const SCOPE_LABELS = { global: '全局', character: '角色', chat: '对话' };
  const FEATURE_LABELS = {
    writeWorldbook: '写入世界书',
    tableWorldbooks: '表格读取世界书',
    plotWorldbooks: '剧情推进世界书',
    plotPreset: '剧情推进预设',
    tablePreset: '表格预设',
  };
  const NATIVE_PRESET_FEATURES = new Set(['plotPreset', 'tablePreset']);
  const WORLDBOOK_FEATURES = ['writeWorldbook', 'tableWorldbooks', 'plotWorldbooks'];
  const PAGE_BLOCKED_WORLDBOOK_KEYWORDS = [
    '规则', '思维链', 'cot', 'MVU', 'mvu', '变量', '状态',
    'Status', 'Rule', 'rule', '检定', '判断', '叙事', '文风',
    'InitVar', '格式',
  ];
  const DATABASE_CHAT_READY_MIN_DELAY_MS = 1100;
  const DATABASE_CHAT_SETTLE_DELAY_MS = 1600;
  const DATABASE_TABLE_READY_TIMEOUT_MS = 30000;
  const DATABASE_WORLDBOOK_API_TIMEOUT_MS = 30000;
  const DATABASE_TEMPLATE_RESTORE_TIMEOUT_MS = 30000;

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function uniqueNames(values) {
    const seen = new Set();
    const output = [];
    for (const value of values || []) {
      const name = String(value || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      output.push(name);
    }
    return output;
  }

  function classifyDatabaseTableDataCore(tableData) {
    return isObject(tableData) && Object.keys(tableData).length > 0
      ? 'ready'
      : 'cleared';
  }

  function isPersistedDatabaseTableUpdateCore(meta) {
    return !isObject(meta) || meta.persisted !== false;
  }

  function isDatabaseTransitionReadyCore({
    transition,
    currentSettingsGeneration,
    currentChatKey,
    currentRevision,
    updatedAt,
  }) {
    if (!transition) return true;
    if (!currentChatKey || transition.settingsGeneration !== currentSettingsGeneration
      || transition.chatKey !== currentChatKey) return false;
    if (transition.manualApproved) return true;
    return currentRevision > transition.baselineRevision
      && updatedAt >= transition.notBefore;
  }

  function isBindingContextCurrentCore(context, current) {
    return !!context?.chatKey && current.started !== false
      && context.chatKey === current.chatKey
      && context.epoch === current.epoch;
  }

  function sortedNames(values) {
    return uniqueNames(values).sort();
  }

  function cleanChatName(value) {
    let name = String(value || '').trim();
    if (!name || name === 'null' || name === 'undefined') return '';
    name = name.split(/[\\/]/).pop() || '';
    return name.replace(/\.jsonl?$/i, '');
  }

  function resolveCharacterIdentityCore(helperId, helperName, characterIndex, characters) {
    const index = Number(characterIndex);
    const character = Number.isInteger(index) && index >= 0 && Array.isArray(characters)
      ? characters[index]
      : null;
    const fallbackId = String(character?.avatar || '').trim();
    const id = String(helperId || '').trim() || fallbackId;
    const name = String(helperName || '').trim() || String(character?.name || '').trim();
    return {
      id,
      name,
      stable: !!id,
      key: `character:${id || 'unknown'}`,
    };
  }

  function hashText(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function defaultState() {
    return {
      version: 1,
      enabled: true,
      profiles: {},
      ui: {
        scopes: Object.fromEntries(FEATURE_IDS.map(feature => [feature, 'chat'])),
      },
    };
  }

  function normalizeBindingContainer(value) {
    const source = isObject(value) ? value : {};
    const output = {};
    for (const feature of FEATURE_IDS) {
      if (Object.prototype.hasOwnProperty.call(source, feature)) {
        output[feature] = normalizePatchOwnedBindingCore(feature, source[feature]);
      }
    }
    return output;
  }

  function normalizeWorldbookBindingCore(value) {
    const source = ['manual', 'active'].includes(value?.source) ? value.source : 'character';
    if (source !== 'manual') {
      return { source, manualSelection: [], enabledEntries: {} };
    }
    const manualSelection = uniqueNames(value?.manualSelection);
    const enabledEntries = {};
    for (const name of manualSelection) {
      if (Array.isArray(value?.enabledEntries?.[name])) {
        enabledEntries[name] = clone(value.enabledEntries[name]);
      }
    }
    return { source, manualSelection, enabledEntries };
  }

  function normalizePatchOwnedBindingCore(feature, value) {
    if (feature === 'tableWorldbooks' || feature === 'plotWorldbooks') {
      return normalizeWorldbookBindingCore(value);
    }
    return clone(value);
  }

  function normalizeEmbeddedTablePresetCore(value, fallbackId = '') {
    if (!isObject(value)) return null;
    const id = String(value.id || fallbackId || '').trim();
    const name = String(value.name || '').trim();
    if (!id || !name || !isObject(value.template)) return null;
    return {
      schema: EMBEDDED_TABLE_PRESET_SCHEMA,
      version: 1,
      id,
      name,
      template: clone(value.template),
      source: isObject(value.source) ? clone(value.source) : {},
      updatedAt: Number(value.updatedAt) || 0,
    };
  }

  function normalizeCharacterPatchRootCore(value) {
    const source = isObject(value) ? value : {};
    const output = { version: 1, profiles: {} };
    if (!isObject(source.profiles)) return output;
    for (const [profileKey, rawProfile] of Object.entries(source.profiles)) {
      if (!isObject(rawProfile)) continue;
      const table = {};
      const rawTable = rawProfile.embeddedPresets?.table;
      if (isObject(rawTable)) {
        for (const [id, rawPreset] of Object.entries(rawTable)) {
          const preset = normalizeEmbeddedTablePresetCore(rawPreset, id);
          if (preset) table[preset.id] = preset;
        }
      }
      output.profiles[profileKey] = {
        bindings: normalizeBindingContainer(rawProfile.bindings),
        embeddedPresets: { table },
        legacyImported: rawProfile.legacyImported === true,
      };
    }
    return output;
  }

  function normalizeState(value) {
    const source = isObject(value) ? value : {};
    const output = defaultState();
    output.enabled = source.enabled !== false;
    output.ui.scopes = { ...output.ui.scopes };

    if (isObject(source.ui?.scopes)) {
      for (const feature of FEATURE_IDS) {
        const scope = source.ui.scopes[feature];
        if (SCOPE_IDS.includes(scope)) output.ui.scopes[feature] = scope;
      }
    }

    if (isObject(source.profiles)) {
      for (const [profileKey, rawProfile] of Object.entries(source.profiles)) {
        if (!isObject(rawProfile)) continue;
        const profile = {
          global: normalizeBindingContainer(rawProfile.global),
          characters: {},
        };
        if (isObject(rawProfile.characters)) {
          for (const [characterKey, rawBindings] of Object.entries(rawProfile.characters)) {
            profile.characters[characterKey] = normalizeBindingContainer(rawBindings);
          }
        }
        output.profiles[profileKey] = profile;
      }
    }
    return output;
  }

  function resolveEditScopeCore(feature, runtimeScopes, savedScopes) {
    const runtimeScope = runtimeScopes?.[feature];
    if (SCOPE_IDS.includes(runtimeScope)) return runtimeScope;
    const savedScope = savedScopes?.[feature];
    return SCOPE_IDS.includes(savedScope) ? savedScope : 'chat';
  }

  function resolveBindingCore(feature, globalBindings, characterBindings, chatBindings) {
    const candidates = [
      ['chat', chatBindings],
      ['character', characterBindings],
      ['global', globalBindings],
    ];
    for (const [scope, bindings] of candidates) {
      if (isObject(bindings) && Object.prototype.hasOwnProperty.call(bindings, feature)) {
        return { scope, value: clone(bindings[feature]) };
      }
    }
    return null;
  }

  function inheritMissingChatBindingsCore(features, globalBindings, characterBindings, chatBindings) {
    const bindings = normalizeBindingContainer(chatBindings);
    const inheritedFrom = {};
    for (const feature of features || []) {
      if (Object.prototype.hasOwnProperty.call(bindings, feature)) continue;
      if (isObject(characterBindings) && Object.prototype.hasOwnProperty.call(characterBindings, feature)) {
        bindings[feature] = clone(characterBindings[feature]);
        inheritedFrom[feature] = 'character';
      } else if (isObject(globalBindings) && Object.prototype.hasOwnProperty.call(globalBindings, feature)) {
        bindings[feature] = clone(globalBindings[feature]);
        inheritedFrom[feature] = 'global';
      }
    }
    return { bindings, inheritedFrom };
  }

  function isManagedNativePresetBinding(nativeBinding, managedPreset) {
    if (!(
      nativeBinding
      && managedPreset
      && ['character', 'global'].includes(managedPreset.scope)
      && String(nativeBinding.value ?? '') === String(managedPreset.value ?? '')
    )) {
      return false;
    }
    if (managedPreset.nativeFingerprint) {
      return String(nativeBinding.nativeFingerprint || '') === String(managedPreset.nativeFingerprint);
    }
    if (Number(managedPreset.nativeUpdatedAt) > 0 && Number(nativeBinding.nativeUpdatedAt) > 0) {
      return Number(nativeBinding.nativeUpdatedAt) === Number(managedPreset.nativeUpdatedAt);
    }
    return true;
  }

  function needsNativePresetRestoreCore(
    feature,
    nativeBinding,
    actualPresetName,
    appliedToken,
    expectedToken,
  ) {
    if (!nativeBinding) return false;
    if (feature === 'plotPreset') {
      return String(actualPresetName || '') !== String(nativeBinding.value || '');
    }
    return false;
  }

  function tableTemplateMatchesRuntimeCore(template, data) {
    try {
      const snapshot = typeof template === 'string' ? JSON.parse(template) : template;
      const current = typeof data === 'string' ? JSON.parse(data) : data;
      if (!isObject(snapshot) || !isObject(current)) return false;
      const keys = value => Object.keys(value).filter(key => key.startsWith('sheet_')).sort();
      const expectedKeys = keys(snapshot);
      if (!expectedKeys.length || stableStringify(expectedKeys) !== stableStringify(keys(current))) return false;
      return expectedKeys.every(key => {
        const expected = snapshot[key];
        const actual = current[key];
        if (!isObject(expected) || !isObject(actual)
          || !Array.isArray(expected.content?.[0]) || !Array.isArray(actual.content?.[0])) return false;
        // Rows change through normal table writes; restoring a binding must not replay them.
        const structure = sheet => ({
          ...Object.fromEntries(Object.entries(sheet).filter(([field]) => !['content', 'seedRows'].includes(field))),
          content: [sheet.content[0]],
        });
        return stableStringify(structure(expected)) === stableStringify(structure(actual));
      });
    } catch (_) {
      return false;
    }
  }

  function normalizePresetApiResultCore(result) {
    const objectResult = isObject(result);
    const blockers = objectResult && Array.isArray(result.blockers)
      ? result.blockers
        .map(blocker => String(isObject(blocker) ? blocker.message || '' : blocker || '').trim())
        .filter(Boolean)
      : [];
    const success = (
      result === true
      || (
        objectResult
        && result.success !== false
        && result.saved !== false
      )
    );
    const saved = success && (!objectResult || result.saved !== false);
    const runtimeReady = !objectResult || result.runtimeReady !== false;
    const warning = objectResult
      ? String(result.postCommitWarning || result.warning || '').trim()
      : '';
    const error = objectResult && !success
      ? String(result.error || result.message || blockers.join('；') || '').trim()
      : (!success ? '数据库预设 API 未返回成功结果' : '');
    return {
      success,
      saved,
      runtimeReady,
      warning,
      error,
      blockers,
      fullyApplied: success && saved && runtimeReady,
    };
  }

  function isDestructiveTemplateBlockerCore(value) {
    return typeof value === 'string' && /删除(?:表|列).+需要显式确认/.test(value);
  }

  function resolvePresetBindingCore(feature, characterBindings, nativeChatBinding, nativeGlobalBinding) {
    if (nativeChatBinding) return clone(nativeChatBinding);
    if (isObject(characterBindings) && Object.prototype.hasOwnProperty.call(characterBindings, feature)) {
      return { scope: 'character', value: clone(characterBindings[feature]) };
    }
    return nativeGlobalBinding ? clone(nativeGlobalBinding) : null;
  }


  function resolveControlFallbackCore(feature, scope, databaseValue) {
    if (feature === 'tablePreset' && scope === 'character') return '';
    return clone(databaseValue);
  }

  function usesCharacterWorldbookSettingsCore(settings, sourceTag = '') {
    const version = String(sourceTag).match(/^spv(\d+)\.(\d+)(?:\.(\d+))?$/i);
    if (version) {
      const major = Number(version[1]);
      const minor = Number(version[2]);
      const patch = Number(version[3] || 0);
      return major > 9 || (major === 9 && (minor > 2 || (minor === 2 && patch >= 3)));
    }
    return isObject(settings?.plotWorldbookConfigByCharacter);
  }

  function databaseWorldbookScopeKeyCore(settings, identity, sourceTag = '') {
    if (!usesCharacterWorldbookSettingsCore(settings, sourceTag)) return identity.chatKey;
    return identity.databaseCharacterKey || identity.chatKey || 'default';
  }

  function syncPlotWorldbookStoreCore(settings, identity, sourceTag = '') {
    if (!usesCharacterWorldbookSettingsCore(settings, sourceTag)) return false;
    const config = settings?.plotSettings?.plotWorldbookConfig;
    if (!identity.databaseCharacterKey || !isObject(config)) return false;
    const key = databaseWorldbookScopeKeyCore(settings, identity, sourceTag);
    if (!isObject(settings.plotWorldbookConfigByCharacter)) settings.plotWorldbookConfigByCharacter = {};
    if (stableStringify(settings.plotWorldbookConfigByCharacter[key]) === stableStringify(config)) return false;
    settings.plotWorldbookConfigByCharacter[key] = clone(config);
    return true;
  }

  function materializeWorldbookSource(config, binding, activeNames) {
    const output = isObject(config) ? clone(config) : {};
    const source = String(binding?.source || 'character');
    output.source = source === 'active' ? 'manual' : (source === 'manual' ? 'manual' : 'character');
    if (source === 'active') {
      output.manualSelection = uniqueNames(activeNames);
    } else if (source === 'manual') {
      output.manualSelection = uniqueNames(binding?.manualSelection);
    } else if (!Array.isArray(output.manualSelection)) {
      output.manualSelection = [];
    }
    output.enabledEntries = isObject(binding?.enabledEntries)
      ? clone(binding.enabledEntries)
      : (isObject(output.enabledEntries) ? output.enabledEntries : {});
    return output;
  }

  function applyWorldbookConfigAtomic(config, desired) {
    if (!isObject(config) || !isObject(desired)) return false;
    const nextSource = desired.source === 'manual' ? 'manual' : 'character';
    const nextSelection = nextSource === 'manual'
      ? uniqueNames(desired.manualSelection)
      : [];
    const nextEnabledEntries = isObject(desired.enabledEntries)
      ? clone(desired.enabledEntries)
      : {};
    const changed = (
      config.source !== nextSource
      || stableStringify(sortedNames(config.manualSelection))
        !== stableStringify(sortedNames(nextSelection))
      || stableStringify(config.enabledEntries || {}) !== stableStringify(nextEnabledEntries)
    );
    if (!changed) return false;
    config.source = nextSource;
    config.manualSelection = nextSelection;
    config.enabledEntries = nextEnabledEntries;
    return true;
  }

  function filterChoiceOptionsCore(options, query, selectedValue) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    return (options || []).filter(item => (
      String(item?.value ?? '') === String(selectedValue ?? '')
      || !needle
      || String(item?.label ?? '').toLocaleLowerCase().includes(needle)
    ));
  }

  function canonicalizeWorldbookControlValue(value, activeNames = []) {
    const source = value?.source === 'manual'
      ? 'manual'
      : (value?.source === 'active' ? 'active' : 'character');
    const bookNames = source === 'manual'
      ? sortedNames(value?.manualSelection)
      : (source === 'active' ? sortedNames(activeNames) : []);
    const enabledEntries = {};
    for (const bookName of bookNames) {
      const uids = Array.isArray(value?.enabledEntries?.[bookName])
        ? [...new Set(value.enabledEntries[bookName].map(uid => String(uid)))].sort()
        : [];
      if (uids.length) enabledEntries[bookName] = uids;
    }
    return { source, bookNames, enabledEntries };
  }

  function controlValuesEquivalentCore(feature, left, right, activeNames = []) {
    if (feature === 'tableWorldbooks' || feature === 'plotWorldbooks') {
      return stableStringify(canonicalizeWorldbookControlValue(left, activeNames))
        === stableStringify(canonicalizeWorldbookControlValue(right, activeNames));
    }
    return stableStringify(left) === stableStringify(right);
  }

  function normalizeCharacterTablePresetBindingCore(value) {
    if (isObject(value)) {
      const source = value.source === 'embedded' ? 'embedded' : 'global';
      return {
        source,
        presetName: String(value.presetName ?? value.value ?? '').trim(),
        embeddedPresetId: source === 'embedded'
          ? String(value.embeddedPresetId ?? value.presetId ?? '').trim()
          : '',
        mergeGlobal: value.mergeGlobal === true,
      };
    }
    return {
      source: 'global',
      presetName: String(value ?? '').trim(),
      embeddedPresetId: '',
      mergeGlobal: false,
    };
  }

  function getTablePresetBindingNameCore(value) {
    const normalized = normalizeCharacterTablePresetBindingCore(value);
    return normalized.source === 'embedded'
      ? normalized.embeddedPresetId
      : normalized.presetName;
  }

  function serializeTablePresetSelectionCore(value) {
    const normalized = normalizeCharacterTablePresetBindingCore(value);
    return normalized.source === 'embedded'
      ? `embedded:${normalized.embeddedPresetId}`
      : normalized.presetName;
  }

  function parseTablePresetSelectionCore(value, mergeGlobal = false) {
    const selected = String(value || '').trim();
    if (selected.startsWith('embedded:')) {
      return {
        source: 'embedded',
        presetName: '',
        embeddedPresetId: selected.slice('embedded:'.length),
        mergeGlobal: mergeGlobal === true,
      };
    }
    return {
      source: 'global',
      presetName: selected,
      embeddedPresetId: '',
      mergeGlobal: mergeGlobal === true,
    };
  }

  function normalizeTemplateTableNameCore(value) {
    const text = String(value ?? '').trim();
    return typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
  }

  function parseTemplateSnapshotCore(value, label = '模板') {
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch (error) {
        throw new Error(`${label}不是有效 JSON：${error?.message || error}`);
      }
    }
    if (!isObject(parsed)) throw new Error(`${label}不是有效模板对象`);
    const sheetKeys = Object.keys(parsed).filter(key => key.startsWith('sheet_'));
    if (!sheetKeys.length) throw new Error(`${label}没有表格`);
    for (const key of sheetKeys) {
      if (!isObject(parsed[key]) || !normalizeTemplateTableNameCore(parsed[key].name)) {
        throw new Error(`${label}中的表格 ${key} 缺少名称`);
      }
    }
    return clone(parsed);
  }

  function mergeTableTemplatesCore(sources) {
    if (!Array.isArray(sources) || !sources.length) throw new Error('至少选择一个模板');
    const metadata = {};
    const records = [];
    const recordByName = new Map();
    const usedKeys = new Set();

    const reserveSheetKey = (requested, tableName) => {
      const base = /^sheet_[A-Za-z0-9_-]+$/.test(String(requested || ''))
        ? String(requested)
        : `sheet_sjbp_${hashText(tableName)}`;
      let candidate = base;
      let suffix = 2;
      while (usedKeys.has(candidate)) {
        candidate = `${base}_${suffix}`;
        suffix += 1;
      }
      usedKeys.add(candidate);
      return candidate;
    };

    sources.forEach((source, sourceIndex) => {
      const label = String(source?.label || `模板 ${sourceIndex + 1}`);
      const template = parseTemplateSnapshotCore(source?.template ?? source, label);
      for (const [key, value] of Object.entries(template)) {
        if (!key.startsWith('sheet_')) metadata[key] = clone(value);
      }
      const sheetEntries = Object.entries(template)
        .filter(([key]) => key.startsWith('sheet_'))
        .sort((left, right) => {
          const leftOrder = Number(left[1]?.orderNo);
          const rightOrder = Number(right[1]?.orderNo);
          const normalizedLeft = Number.isFinite(leftOrder) ? leftOrder : Number.MAX_SAFE_INTEGER;
          const normalizedRight = Number.isFinite(rightOrder) ? rightOrder : Number.MAX_SAFE_INTEGER;
          return normalizedLeft - normalizedRight;
        });

      for (const [sourceKey, rawTable] of sheetEntries) {
        const tableName = normalizeTemplateTableNameCore(rawTable.name);
        const existing = recordByName.get(tableName);
        if (existing) {
          const replacement = clone(rawTable);
          replacement.uid = existing.key;
          existing.table = replacement;
          existing.sourceIndex = sourceIndex;
          continue;
        }
        const key = reserveSheetKey(sourceKey || rawTable.uid, tableName);
        const table = clone(rawTable);
        table.uid = key;
        const record = { key, table, sourceIndex };
        records.push(record);
        recordByName.set(tableName, record);
      }
    });

    const merged = {
      ...metadata,
      mate: isObject(metadata.mate) ? metadata.mate : { type: 'chatSheets', version: 1 },
    };
    records.forEach((record, index) => {
      record.table.orderNo = index;
      merged[record.key] = record.table;
    });
    return merged;
  }

  function stripWorldbookSkillMetaCore(value) {
    return String(value || '')
      .replace(/\n?<!--\s*ACU_SKILL_META_START\s*\n[\s\S]*?\nACU_SKILL_META_END\s*-->\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeWorldbookEntriesCore(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
      .filter(entry => entry && typeof entry === 'object')
      .map((entry, index) => ({
        ...entry,
        uid: entry.uid ?? entry.id ?? index,
        comment: String(entry.comment ?? entry.name ?? ''),
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : entry.disable !== true,
        type: entry.type
          ?? entry.strategy?.type
          ?? (entry.constant ? 'constant' : (entry.vectorized ? 'vectorized' : 'selective')),
        display_index: entry.display_index ?? entry.displayIndex ?? index,
      }));
  }

  function isWorldbookEntryVisibleCore(entry, hasSnapshot = false) {
    if (hasSnapshot) return true;
    const comment = String(entry?.comment || entry?.name || '');
    const withoutIsolation = comment.replace(/^ACU-\[[^\]]+\]-/, '');
    if (!withoutIsolation.trim().startsWith('外部导入-')) {
      const normalized = withoutIsolation.replace(/^外部导入-(?:[^-]+-)?/, '');
      if (
        normalized.startsWith('TavernDB-ACU-OutlineTable')
        || normalized.startsWith('TavernDB-ACU-')
        || normalized.startsWith('重要人物条目')
        || normalized.startsWith('总结条目')
        || normalized.startsWith('小总结条目')
      ) return false;
    }
    return !PAGE_BLOCKED_WORLDBOOK_KEYWORDS.some(keyword => comment.includes(keyword));
  }

  function buildWorldbookEntryGroupsCore(
    bookNames,
    entriesByBook,
    enabledEntries,
    snapshot = null,
    expandedBooks = [],
  ) {
    const nextEnabledEntries = isObject(enabledEntries) ? clone(enabledEntries) : {};
    const expanded = new Set(expandedBooks || []);
    const snapshotBooks = snapshot?.active === true && isObject(snapshot.books)
      ? snapshot.books
      : {};
    const groups = [];

    for (const bookName of uniqueNames(bookNames)) {
      const snapshotByUid = new Map(
        (Array.isArray(snapshotBooks[bookName]) ? snapshotBooks[bookName] : [])
          .filter(item => item && String(item.uid ?? '') !== '')
          .map(item => [String(item.uid), item]),
      );
      const sourceEntries = Array.isArray(entriesByBook?.[bookName]) ? entriesByBook[bookName] : [];
      const visibleEntries = sourceEntries.filter(entry => (
        isWorldbookEntryVisibleCore(entry, snapshotByUid.has(String(entry?.uid)))
      ));
      const visibleUidSet = new Set(visibleEntries.map(entry => String(entry?.uid)));
      let selectedUids;

      if (!Array.isArray(nextEnabledEntries[bookName])) {
        selectedUids = visibleEntries
          .filter(entry => {
            const snapshotEntry = snapshotByUid.get(String(entry?.uid));
            return snapshotEntry ? snapshotEntry.previousEnabled !== false : entry?.enabled !== false;
          })
          .map(entry => entry.uid);
      } else {
        selectedUids = nextEnabledEntries[bookName]
          .filter(uid => visibleUidSet.has(String(uid)));
      }
      nextEnabledEntries[bookName] = selectedUids;
      const selectedUidSet = new Set(selectedUids.map(uid => String(uid)));
      const entries = visibleEntries.map(entry => {
        const snapshotEntry = snapshotByUid.get(String(entry?.uid));
        const enabled = snapshotEntry ? snapshotEntry.previousEnabled !== false : entry?.enabled !== false;
        const type = String(
          snapshotEntry?.previousType
          ?? entry?.type
          ?? entry?.strategy?.type
          ?? '',
        );
        const comment = String(entry?.comment || entry?.name || '');
        return {
          uid: entry.uid,
          bookName,
          label: stripWorldbookSkillMetaCore(comment) || `条目 ${entry.uid}`,
          checked: selectedUidSet.has(String(entry.uid)),
          disabled: !enabled,
          isConstant: type.trim().toLocaleLowerCase() === 'constant',
        };
      });
      if (entries.length) groups.push({ bookName, entries, expanded: expanded.has(bookName) });
    }

    return { groups, enabledEntries: nextEnabledEntries };
  }

  function normalizeActiveSourcesCore(raw) {
    const global = uniqueNames(raw?.global);
    const primary = String(raw?.characterPrimary || '').trim();
    const additional = uniqueNames(raw?.characterAdditional);
    const chat = uniqueNames(Array.isArray(raw?.chat) ? raw.chat : [raw?.chat]);
    const persona = String(raw?.persona || '').trim();
    const all = uniqueNames([...global, primary, ...additional, ...chat, persona]);
    const available = uniqueNames([...(raw?.available || []), ...all]);
    return {
      global,
      characterPrimary: primary,
      characterAdditional: additional,
      chat,
      persona,
      personaAvatar: String(raw?.personaAvatar || ''),
      all,
      available,
    };
  }

  async function captureObjectViaStringify(
    jsonObject,
    trigger,
    predicate,
    waitMs = 0,
    onCapture = null,
  ) {
    const original = jsonObject.stringify;
    let captured = null;
    function wrappedStringify(value, ...args) {
      if (!captured && predicate(value)) {
        if (typeof onCapture === 'function') onCapture(value);
        captured = value;
      }
      return Reflect.apply(original, this, [value, ...args]);
    }
    try {
      jsonObject.stringify = wrappedStringify;
      await trigger();
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    } finally {
      try {
        if (jsonObject.stringify === wrappedStringify) jsonObject.stringify = original;
      } catch (_) {
        // The source iframe may have reloaded during capture.
      }
    }
    return captured;
  }

  function resolveHostDocumentCore(jquery, fallbackDocument) {
    try {
      const document = typeof jquery === 'function'
        ? jquery('html').get(0)?.ownerDocument
        : null;
      if (document) return document;
    } catch (_) {
      // Fall back while Tavern Helper is still initializing.
    }
    return fallbackDocument;
  }

  function captureDialogScrollStateCore(state, overlay, previousDialog) {
    if (!state || !previousDialog) return;
    if (previousDialog.classList?.contains?.('sjbp-manual-dialog')) {
      state.manualDialogScrollTop = overlay?.querySelector?.('.sjbp-manual-body')?.scrollTop || 0;
    } else {
      state.mainDialogScrollTop = previousDialog.scrollTop || 0;
    }
  }

  function restoreDialogScrollStateCore(state, overlay, manualEditorActive) {
    if (!state || !overlay) return;
    if (manualEditorActive) {
      const manualBody = overlay.querySelector?.('.sjbp-manual-body');
      if (manualBody) manualBody.scrollTop = state.manualDialogScrollTop || 0;
      return;
    }
    const dialog = overlay.querySelector?.('.sjbp-dialog');
    if (dialog) dialog.scrollTop = state.mainDialogScrollTop || 0;
  }

  function restorePublishedGlobalCore(
    hostWindow,
    globalName,
    currentValue,
    previousValue,
    initializer,
  ) {
    if (
      !hostWindow
      || hostWindow[globalName] !== currentValue
      || typeof initializer !== 'function'
    ) return false;
    initializer(globalName, previousValue);
    return true;
  }

  function variableGetterHonorsOptionsCore(getter) {
    if (typeof getter !== 'function' || typeof Proxy !== 'function') return false;
    let typeRead = false;
    const option = new Proxy({ type: 'chat' }, {
      get(target, property, receiver) {
        if (property === 'type') typeRead = true;
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      getter(option);
    } catch (_) {
      // Reading option.type is enough to distinguish the injected API from a shadowing wrapper.
    }
    return typeRead;
  }

  function findDatabaseFrameCore(frames, api) {
    if (!api || typeof api.getUpdateConfigParams !== 'function'
      || typeof api.setUpdateConfigParams !== 'function') return null;
    const matches = [];
    for (const frame of frames || []) {
      if (frame.isConnected === false) continue;
      try {
        const owner = frame.contentWindow;
        // Settings interception must run in the realm executing the public setter.
        // Do not infer ownership from script names, IDs or quoted loader source.
        if (owner?.Function?.prototype
          && Object.prototype.isPrototypeOf.call(owner.Function.prototype, api.setUpdateConfigParams)
          && Object.getPrototypeOf(api) === owner.Object?.prototype) {
          matches.push(frame);
        }
      } catch (_) {
        // Cross-origin and unloading frames cannot own a usable settings hook.
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function readDatabaseSourceTagCore(source) {
    const text = String(source || '');
    const tag = text.match(/AlbusKen\/shujuku@([^/'"\\\s<]+)/i)?.[1];
    if (tag) return tag;
    const version = text.match(/^\s*\/\/\s*@version\s+(\d+\.\d+(?:\.\d+)?)\s*$/m)?.[1];
    // Older bundles retain an unrelated 2.0.0 userscript header. Do not report
    // that as a database release; existing settings-shape detection handles unknown tags.
    return version && Number(version.split('.')[0]) >= 8 ? `spv${version}` : '';
  }

  const testTarget = typeof globalThis !== 'undefined' ? globalThis[TEST_KEY] : null;
  if (testTarget) {
    Object.assign(testTarget, {
      uniqueNames,
      sortedNames,
      cleanChatName,
      resolveCharacterIdentityCore,
      hashText,
      defaultState,
      normalizeState,
      normalizeWorldbookBindingCore,
      normalizeCharacterPatchRootCore,
      normalizeEmbeddedTablePresetCore,
      resolveEditScopeCore,
      resolveBindingCore,
      inheritMissingChatBindingsCore,
      resolvePresetBindingCore,
      resolveControlFallbackCore,
      isManagedNativePresetBinding,
      materializeWorldbookSource,
      usesCharacterWorldbookSettingsCore,
      databaseWorldbookScopeKeyCore,
      syncPlotWorldbookStoreCore,
      applyWorldbookConfigAtomic,
      filterChoiceOptionsCore,
      canonicalizeWorldbookControlValue,
      controlValuesEquivalentCore,
      normalizeCharacterTablePresetBindingCore,
      getTablePresetBindingNameCore,
      serializeTablePresetSelectionCore,
      parseTablePresetSelectionCore,
      normalizeTemplateTableNameCore,
      parseTemplateSnapshotCore,
      mergeTableTemplatesCore,
      stripWorldbookSkillMetaCore,
      normalizeWorldbookEntriesCore,
      isWorldbookEntryVisibleCore,
      buildWorldbookEntryGroupsCore,
      normalizeActiveSourcesCore,
      captureObjectViaStringify,
      needsNativePresetRestoreCore,
      tableTemplateMatchesRuntimeCore,
      normalizePresetApiResultCore,
      resolveHostDocumentCore,
      captureDialogScrollStateCore,
      restoreDialogScrollStateCore,
      restorePublishedGlobalCore,
      variableGetterHonorsOptionsCore,
      findDatabaseFrameCore,
      readDatabaseSourceTagCore,
      classifyDatabaseTableDataCore,
      isPersistedDatabaseTableUpdateCore,
      isDatabaseTransitionReadyCore,
      isBindingContextCurrentCore,
      isDestructiveTemplateBlockerCore,
    });
    return;
  }

  function getHostDocument() {
    return resolveHostDocumentCore(
      typeof $ === 'function' ? $ : null,
      window.document,
    );
  }

  const hostDocument = getHostDocument();
  const host = hostDocument.defaultView || window;
  const previousRuntime = host[RUNTIME_KEY];
  if (previousRuntime?.version === PATCH_VERSION && previousRuntime?.started) {
    console.info(`[${PATCH_NAME}] v${PATCH_VERSION} already started.`);
    return;
  }
  try {
    previousRuntime?.destroy?.();
  } catch (_) {
    // Ignore cleanup failures from an older patch build.
  }
  const previousHostApi = host.ShujukuScopeBindingPatch;

  const runtime = {
    version: PATCH_VERSION,
    started: true,
    settingsRef: null,
    settingsGeneration: 0,
    contextEpoch: 0,
    contextController: new AbortController(),
    databaseProfileKey: '',
    dbFrame: null,
    dbFrameWindow: null,
    dbApi: null,
    activeWorldbooks: {
      global: [],
      characterPrimary: '',
      characterAdditional: [],
      chat: [],
      persona: '',
      all: [],
      available: [],
    },
    applyTimer: null,
    databaseUiTimer: null,
    postCaptureReapplyTimer: null,
    postCaptureRefreshWriteWorldbook: false,
    postCaptureResetWriteWorldbook: false,
    postCaptureGeneration: 0,
    postCaptureRetryAttempt: 0,
    presetRetryTimers: {},
    presetRetryAttempts: {},
    presetWarnings: {},
    databaseUiSyncTimers: {},
    databaseUiOpenTimers: [],
    databaseUiDriving: false,
    databaseUiVisible: false,
    applyQueue: Promise.resolve(false),
    pollTimer: null,
    mutationObserver: null,
    eventDisposers: [],
    applying: false,
    lastApplySignature: '',
    lastApplyReason: '',
    lastApplyAt: 0,
    lastWorldbookTransition: null,
    lastWriteWorldbookRefresh: null,
    writeWorldbookResetPromise: null,
    writeWorldbookResetRequestPromise: null,
    writeWorldbookResetState: null,
    worldbookApiPending: null,
    pendingWriteWorldbookTransition: null,
    databaseTableRevision: 0,
    databaseTableUpdatedAt: 0,
    databaseTableUnpersistedAt: 0,
    databaseTableDataState: 'unknown',
    databaseTableCallback: null,
    databaseTableCallbackApi: null,
    nativePresetAppliedTokens: {},
    nativeTemplateRestorePending: null,
    controlDrafts: {},
    editScopes: {},
    manualEditor: null,
    templateMergeEditor: null,
    mainDialogScrollTop: 0,
    manualDialogScrollTop: 0,
    choiceMenuDisposer: null,
    lastError: '',
    overlay: null,
    panelLoading: false,
    menuItem: null,
    menuContainer: null,
    previousHostApi,
    api: null,
    variableGetterRef: null,
    variableApiMode: 'unknown',
  };
  host[RUNTIME_KEY] = runtime;

  function log(...args) {
    console.info(`[${PATCH_NAME}]`, ...args);
  }

  function warn(...args) {
    console.warn(`[${PATCH_NAME}]`, ...args);
  }

  function clearPresetRuntimeRetry(feature, clearWarning = true) {
    clearTimeout(runtime.presetRetryTimers[feature]);
    delete runtime.presetRetryTimers[feature];
    delete runtime.presetRetryAttempts[feature];
    if (clearWarning) delete runtime.presetWarnings[feature];
  }

  function resetPresetRuntimeState() {
    for (const timer of Object.values(runtime.presetRetryTimers)) clearTimeout(timer);
    runtime.presetRetryTimers = {};
    runtime.presetRetryAttempts = {};
    runtime.presetWarnings = {};
  }

  function schedulePresetRuntimeRetry(feature) {
    if (runtime.presetRetryTimers[feature]) return;
    const delays = [1800, 4000, 8000];
    const attempts = Number(runtime.presetRetryAttempts[feature] || 0);
    if (attempts >= delays.length) {
      warn(`${FEATURE_LABELS[feature]}运行时仍未就绪；自动重试已达上限，等待下一次数据库或对话事件。`);
      return;
    }
    const attempt = attempts + 1;
    runtime.presetRetryAttempts[feature] = attempt;
    runtime.presetRetryTimers[feature] = setTimeout(() => {
      delete runtime.presetRetryTimers[feature];
      runtime.lastApplySignature = '';
      void applyBindings(
        `${FEATURE_LABELS[feature]}运行时就绪复核 ${attempt}/${delays.length}`,
        true,
      );
    }, delays[attempts]);
  }

  function handleTemplatePresetApiResult(feature, result, context) {
    const outcome = normalizePresetApiResultCore(result);
    if (!outcome.success || !outcome.saved) {
      clearPresetRuntimeRetry(feature, false);
      throw new Error(`${context}失败: ${outcome.error || '数据库未保存预设'}`);
    }

    if (outcome.warning) {
      runtime.presetWarnings[feature] = `${context}：${outcome.warning}`;
      warn(runtime.presetWarnings[feature]);
    } else {
      delete runtime.presetWarnings[feature];
    }

    if (outcome.runtimeReady === false) {
      if (!runtime.presetWarnings[feature]) {
        runtime.presetWarnings[feature] = `${context}已保存，但数据库运行时尚未就绪`;
      }
      delete runtime.nativePresetAppliedTokens[feature];
      schedulePresetRuntimeRetry(feature);
    } else {
      clearPresetRuntimeRetry(feature, !outcome.warning);
    }
    return outcome;
  }

  function describePresetWarnings() {
    return Object.entries(runtime.presetWarnings)
      .filter(([, message]) => String(message || '').trim())
      .map(([feature, message]) => `${FEATURE_LABELS[feature] || feature}：${message}`);
  }

  async function switchTemplatePresetWithConfirmation(api, presetName, options, context) {
    const apply = destructiveChangeConfirmed => api.switchTemplatePreset(presetName, {
      ...options,
      destructiveChangeConfirmed,
    });
    let result = await apply(false);
    const outcome = normalizePresetApiResultCore(result);
    const destructiveBlockers = outcome.blockers.filter(isDestructiveTemplateBlockerCore);
    if (outcome.success || destructiveBlockers.length === 0) return result;

    const confirmed = host.confirm?.(
      `${context}会删除当前聊天中的表或列：\n\n${destructiveBlockers.join('\n')}\n\n确认删除并继续？`,
    );
    if (!confirmed) return result;
    result = await apply(true);
    return result;
  }

  function getSillyTavern() {
    try {
      return typeof SillyTavern !== 'undefined' ? SillyTavern : null;
    } catch (_) {
      return null;
    }
  }

  function getDatabaseApi() {
    return host.AutoCardUpdaterAPI || window.AutoCardUpdaterAPI || null;
  }

  function getExplicitVariableOption(option) {
    if (option?.type !== 'script') return option;
    if (typeof getScriptId !== 'function') {
      throw new Error('酒馆助手 getScriptId 尚不可用');
    }
    const scriptId = String(getScriptId() || '').trim();
    if (!scriptId) throw new Error('无法识别当前脚本 ID');
    return { ...option, script_id: scriptId };
  }

  function shouldUseExplicitVariableApi() {
    const getter = typeof getVariables === 'function' ? getVariables : null;
    if (runtime.variableGetterRef !== getter) {
      runtime.variableGetterRef = getter;
      runtime.variableApiMode = variableGetterHonorsOptionsCore(getter)
        ? 'direct-global'
        : 'helper-explicit';
    }
    return runtime.variableApiMode === 'helper-explicit';
  }

  function getVariableApiFallback() {
    const api = globalThis.TavernHelper;
    return api && typeof api === 'object' ? api : null;
  }

  function readVariablesSafely(option) {
    if (!shouldUseExplicitVariableApi()) return getVariables(option);
    const api = getVariableApiFallback();
    if (typeof api?.getVariables !== 'function') {
      throw new Error('酒馆助手变量全局函数被覆盖，且显式变量 API 不可用');
    }
    return api.getVariables(getExplicitVariableOption(option));
  }

  function updateVariablesSafely(updater, option) {
    if (!shouldUseExplicitVariableApi()) return updateVariablesWith(updater, option);
    const api = getVariableApiFallback();
    if (typeof api?.updateVariablesWith !== 'function') {
      throw new Error('酒馆助手变量全局函数被覆盖，且显式变量 API 不可用');
    }
    return api.updateVariablesWith(updater, getExplicitVariableOption(option));
  }

  function readUserscriptVariables() {
    try {
      const variables = readVariablesSafely({ type: 'extension', extension_id: '__userscripts' });
      return isObject(variables) ? variables : {};
    } catch (error) {
      runtime.lastError = String(error?.message || error);
      return null;
    }
  }

  function readScriptVariables() {
    try {
      const variables = readVariablesSafely({ type: 'script' });
      return isObject(variables) ? variables : {};
    } catch (error) {
      runtime.lastError = String(error?.message || error);
      return null;
    }
  }

  function parseStoredStateSlot(slot) {
    const raw = slot?.state;
    if (isObject(raw)) return normalizeState(raw);
    if (typeof raw === 'string' && raw.trim()) {
      try {
        return normalizeState(JSON.parse(raw));
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function readState() {
    const stored = parseStoredStateSlot(readScriptVariables()?.[PATCH_NAMESPACE]);
    if (stored) return stored;

    const legacy = parseStoredStateSlot(readUserscriptVariables()?.[PATCH_NAMESPACE]);
    if (legacy) {
      try {
        writeState(legacy);
      } catch (_) {
        // The legacy value remains usable for this run if migration cannot persist yet.
      }
      return legacy;
    }
    return defaultState();
  }

  function writeState(state) {
    const normalized = normalizeState(state);
    updateVariablesSafely(variables => {
      const next = isObject(variables) ? variables : {};
      if (!isObject(next[PATCH_NAMESPACE])) next[PATCH_NAMESPACE] = {};
      next[PATCH_NAMESPACE].state = JSON.stringify(normalized);
      return next;
    }, { type: 'script' });
    return normalized;
  }

  function readCharacterPatchRoot() {
    try {
      const variables = readVariablesSafely({ type: 'character' });
      return normalizeCharacterPatchRootCore(variables?.[CHARACTER_META_KEY]);
    } catch (error) {
      runtime.lastError = String(error?.message || error);
      return null;
    }
  }

  function writeCharacterPatchRoot(root) {
    const normalized = normalizeCharacterPatchRootCore(root);
    updateVariablesSafely(variables => {
      const next = isObject(variables) ? variables : {};
      next[CHARACTER_META_KEY] = clone(normalized);
      return next;
    }, { type: 'character' });
    return normalized;
  }

  function getCharacterPatchProfile(root, create = false) {
    const key = getIsolationKey();
    if (!isObject(root?.profiles?.[key])) {
      if (!create) {
        return { bindings: {}, embeddedPresets: { table: {} }, legacyImported: false };
      }
      if (!isObject(root.profiles)) root.profiles = {};
      root.profiles[key] = {
        bindings: {},
        embeddedPresets: { table: {} },
        legacyImported: false,
      };
    }
    const profile = root.profiles[key];
    profile.bindings = normalizeBindingContainer(profile.bindings);
    if (!isObject(profile.embeddedPresets)) profile.embeddedPresets = {};
    if (!isObject(profile.embeddedPresets.table)) profile.embeddedPresets.table = {};
    return profile;
  }

  function getLegacyCharacterBindings(state = readState()) {
    const profile = getProfileState(state, false);
    const bindings = profile.characters[getIdentity().characterKey];
    return isObject(bindings) ? normalizeBindingContainer(bindings) : {};
  }

  function removeLegacyCharacterBindings() {
    const state = readState();
    const profile = getProfileState(state, false);
    const key = getIdentity().characterKey;
    if (!Object.prototype.hasOwnProperty.call(profile.characters, key)) return;
    delete profile.characters[key];
    writeState(state);
  }

  function getCharacterBindings() {
    const identity = getIdentity();
    const legacy = getLegacyCharacterBindings();
    if (!identity.characterStable) return legacy;
    const root = readCharacterPatchRoot();
    if (!root) return legacy;
    const hasLegacy = Object.keys(legacy).length > 0;
    const hasCharacterData = isObject(root.profiles?.[getIsolationKey()]);
    if (!hasLegacy && !hasCharacterData) return {};
    const profile = getCharacterPatchProfile(root, true);
    if (!profile.legacyImported) {
      profile.bindings = {
        ...legacy,
        ...profile.bindings,
      };
      profile.legacyImported = true;
      writeCharacterPatchRoot(root);
      removeLegacyCharacterBindings();
    }
    return normalizeBindingContainer(profile.bindings);
  }

  function getEmbeddedTablePresets() {
    if (!getIdentity().characterStable) return {};
    const root = readCharacterPatchRoot();
    if (!root) return {};
    return clone(getCharacterPatchProfile(root, false).embeddedPresets.table);
  }

  function getEmbeddedTablePreset(id) {
    const preset = getEmbeddedTablePresets()[String(id || '').trim()];
    return preset ? clone(preset) : null;
  }

  function createEmbeddedPresetId(name, presets) {
    const base = `table-${hashText(`${name}:${Date.now()}`)}`;
    let id = base;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(presets, id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    return id;
  }

  function saveEmbeddedTablePreset({ name, template, source = {} }) {
    if (!getIdentity().characterStable) {
      throw new Error('角色尚未加载完成，无法写入内嵌预设');
    }
    const normalizedTemplate = parseTemplateSnapshotCore(template, `内嵌预设 ${name}`);
    const root = readCharacterPatchRoot() || { version: 1, profiles: {} };
    const profile = getCharacterPatchProfile(root, true);
    const id = createEmbeddedPresetId(name, profile.embeddedPresets.table);
    profile.embeddedPresets.table[id] = {
      schema: EMBEDDED_TABLE_PRESET_SCHEMA,
      version: 1,
      id,
      name: String(name || '').trim() || '内嵌表格预设',
      template: normalizedTemplate,
      source: clone(source),
      updatedAt: Date.now(),
    };
    profile.legacyImported = true;
    writeCharacterPatchRoot(root);
    return clone(profile.embeddedPresets.table[id]);
  }

  function deleteEmbeddedTablePreset(id) {
    const presetId = String(id || '').trim();
    if (!presetId || !getIdentity().characterStable) return false;
    const root = readCharacterPatchRoot();
    if (!root) return false;
    const profile = getCharacterPatchProfile(root, true);
    if (!Object.prototype.hasOwnProperty.call(profile.embeddedPresets.table, presetId)) return false;
    delete profile.embeddedPresets.table[presetId];
    const binding = normalizeCharacterTablePresetBindingCore(profile.bindings.tablePreset);
    if (binding.source === 'embedded' && binding.embeddedPresetId === presetId) {
      delete profile.bindings.tablePreset;
    }
    writeCharacterPatchRoot(root);
    return true;
  }

  function getIsolationKey() {
    const settings = runtime.settingsRef;
    return String(settings?.dataIsolationCode || '').trim() || '__default__';
  }

  function getProfileState(state, create = false) {
    const key = getIsolationKey();
    if (!isObject(state.profiles[key])) {
      if (!create) return { global: {}, characters: {} };
      state.profiles[key] = { global: {}, characters: {} };
    }
    const profile = state.profiles[key];
    if (!isObject(profile.global)) profile.global = {};
    if (!isObject(profile.characters)) profile.characters = {};
    return profile;
  }

  function getIdentity() {
    const st = getSillyTavern();
    const chatKey = cleanChatName(
      typeof st?.getCurrentChatId === 'function' ? st.getCurrentChatId() : st?.chatId,
    );
    if (st?.groupId !== undefined && st?.groupId !== null && st?.groupId !== '') {
      const group = Array.isArray(st.groups) ? st.groups.find(item => String(item.id) === String(st.groupId)) : null;
      return {
        chatKey,
        characterKey: `group:${st.groupId}`,
        databaseCharacterKey: `group:${st.groupId}`,
        characterLabel: group?.name || `群组 ${st.groupId}`,
      };
    }
    let helperCharacterId = '';
    let helperCharacterName = '';
    try {
      if (typeof getCurrentCharacterId === 'function') {
        helperCharacterId = String(getCurrentCharacterId() || '').trim();
      }
    } catch (_) {
      // The helper reports no current character while the chat is still loading.
    }
    try {
      if (typeof getCurrentCharacterName === 'function') {
        helperCharacterName = String(getCurrentCharacterName() || '').trim();
      }
    } catch (_) {
      // The helper reports no current character while the chat is still loading.
    }
    const character = resolveCharacterIdentityCore(
      helperCharacterId,
      helperCharacterName,
      st?.characterId,
      st?.characters,
    );
    return {
      chatKey,
      characterKey: character.key,
      databaseCharacterKey: character.id ? `char:${character.id}` : (character.name ? `charname:${character.name}` : ''),
      characterLabel: character.name || character.id || '未选择角色',
      characterStable: character.stable,
    };
  }

  function readChatPatchRoot() {
    let variables = {};
    try {
      variables = readVariablesSafely({ type: 'chat' });
    } catch (_) {
      // The legacy metadata fallback below remains available during chat loading.
    }
    let raw = variables?.[CHAT_META_KEY];
    if (!isObject(raw)) {
      const legacy = getSillyTavern()?.chatMetadata?.[CHAT_META_KEY];
      if (isObject(legacy)) {
        raw = legacy;
        try {
          updateVariablesSafely(current => {
            const next = isObject(current) ? current : {};
            next[CHAT_META_KEY] = clone(legacy);
            return next;
          }, { type: 'chat' });
        } catch (_) {
          // Reading the legacy value is enough for this run.
        }
      }
    }
    const root = isObject(raw) ? clone(raw) : {};
    if (!isObject(root.profiles)) root.profiles = {};
    root.version = 1;
    return root;
  }

  function getChatProfile(root, create = false) {
    const key = getIsolationKey();
    if (!isObject(root.profiles[key])) {
      if (!create) return { bindings: {}, bindingOrigins: {}, managedPresets: {} };
      root.profiles[key] = { bindings: {}, bindingOrigins: {}, managedPresets: {} };
    }
    root.profiles[key].bindings = normalizeBindingContainer(root.profiles[key].bindings);
    if (!isObject(root.profiles[key].bindingOrigins)) root.profiles[key].bindingOrigins = {};
    if (!isObject(root.profiles[key].managedPresets)) root.profiles[key].managedPresets = {};
    return root.profiles[key];
  }

  function writeChatPatchRoot(root) {
    updateVariablesSafely(variables => {
      const next = isObject(variables) ? variables : {};
      next[CHAT_META_KEY] = clone(root);
      return next;
    }, { type: 'chat' });
  }

  function getBindingAtScope(feature, scope) {
    if (NATIVE_PRESET_FEATURES.has(feature) && scope !== 'character') {
      const binding = scope === 'global'
        ? getNativeGlobalPresetBinding(feature)
        : getNativeChatPresetBinding(feature);
      return binding ? clone(binding.value) : undefined;
    }

    const state = readState();
    const profile = getProfileState(state, false);
    const identity = getIdentity();
    if (scope === 'global') {
      return Object.prototype.hasOwnProperty.call(profile.global, feature)
        ? clone(profile.global[feature])
        : undefined;
    }
    if (scope === 'character') {
      const bindings = getCharacterBindings();
      return isObject(bindings) && Object.prototype.hasOwnProperty.call(bindings, feature)
        ? clone(bindings[feature])
        : undefined;
    }
    const chatProfile = getChatProfile(readChatPatchRoot(), false);
    return Object.prototype.hasOwnProperty.call(chatProfile.bindings, feature)
      ? clone(chatProfile.bindings[feature])
      : undefined;
  }

  function resolveBinding(feature) {
    const state = readState();
    if (!state.enabled) return null;
    const profile = getProfileState(state, false);
    const identity = getIdentity();
    const characterBindings = getCharacterBindings();
    const chatProfile = getChatProfile(readChatPatchRoot(), false);
    const chatBindings = chatProfile.bindings;

    if (NATIVE_PRESET_FEATURES.has(feature)) {
      return resolvePresetBindingCore(
        feature,
        characterBindings,
        getNativeChatPresetBinding(feature),
        getNativeGlobalPresetBinding(feature),
        chatProfile.managedPresets[feature],
      );
    }

    return resolveBindingCore(feature, profile.global, characterBindings, chatBindings);
  }

  function ensureWorldbookChatBindings() {
    const identity = getIdentity();
    if (!identity.chatKey) return {};
    const state = readState();
    if (!state.enabled) return {};
    const profileState = getProfileState(state, false);
    const characterBindings = getCharacterBindings();
    const root = readChatPatchRoot();
    const chatProfile = getChatProfile(root, true);
    const inherited = inheritMissingChatBindingsCore(
      WORLDBOOK_FEATURES,
      profileState.global,
      characterBindings,
      chatProfile.bindings,
    );
    const inheritedFeatures = Object.keys(inherited.inheritedFrom);
    if (!inheritedFeatures.length) return {};

    chatProfile.bindings = inherited.bindings;
    for (const feature of inheritedFeatures) {
      chatProfile.bindingOrigins[feature] = inherited.inheritedFrom[feature];
    }
    writeChatPatchRoot(root);
    return inherited.inheritedFrom;
  }

  function getChatBindingOrigin(feature) {
    const profile = getChatProfile(readChatPatchRoot(), false);
    return String(profile.bindingOrigins?.[feature] || '');
  }

  function getDatabaseIsolationSlot() {
    return getIsolationKey() === '__default__' ? '' : getIsolationKey();
  }

  function getNativeGlobalPresetBinding(feature) {
    if (!runtime.settingsRef) return null;
    if (feature === 'plotPreset') {
      return {
        scope: 'global',
        value: String(runtime.settingsRef?.plotSettings?.lastUsedPresetName || ''),
        native: true,
      };
    }
    if (feature === 'tablePreset') {
      return {
        scope: 'global',
        value: String(runtime.settingsRef?.currentTemplatePresetName || ''),
        native: true,
      };
    }
    return null;
  }

  function getNativeTablePresetState() {
    const st = getSillyTavern();
    const slot = getDatabaseIsolationSlot();
    const raw = st?.chatMetadata?.TavernDB_ACU_ScopedConfig?.template?.[slot]
      || st?.chat?.[0]?.TavernDB_ACU_ScopedConfig?.template?.[slot];
    return isObject(raw) && ['chat_override', 'preset_link'].includes(raw.mode)
      ? raw
      : null;
  }

  function getNativeChatPresetBinding(feature) {
    const identity = getIdentity();
    if (feature === 'plotPreset') {
      const raw = runtime.settingsRef?.plotPresetBindings?.[identity.chatKey];
      if (!isObject(raw)) return null;
      const presetName = String(raw.presetName || '').trim();
      return presetName ? {
        scope: 'chat',
        value: presetName,
        native: true,
        nativeUpdatedAt: Number(raw.updatedAt) || 0,
      } : null;
    }
    if (feature === 'tablePreset') {
      const raw = getNativeTablePresetState();
      if (!raw) return null;
      return {
        scope: 'chat',
        value: String(raw.presetName || ''),
        native: true,
        nativeUpdatedAt: Number(raw.updatedAt) || 0,
        nativeFingerprint: hashText(raw.templateStr),
        nativeSource: String(raw.source || ''),
        nativeReason: String(raw.reason || ''),
        originGlobalName: String(raw.originGlobalName || ''),
      };
    }
    return null;
  }

  function buildNativePresetApplyToken(feature, nativeBinding) {
    const identity = getIdentity();
    const revision = feature === 'tablePreset'
      ? String(nativeBinding?.nativeFingerprint || '')
      : String(nativeBinding?.value || '');
    return [
      identity.chatKey,
      getIsolationKey(),
      runtime.settingsGeneration,
      feature,
      revision,
    ].join('|');
  }

  function getManagedPreset(feature) {
    const profile = getChatProfile(readChatPatchRoot(), false);
    return isObject(profile.managedPresets?.[feature])
      ? clone(profile.managedPresets[feature])
      : null;
  }

  function setManagedPreset(feature, marker) {
    const root = readChatPatchRoot();
    const profile = getChatProfile(root, true);
    const current = profile.managedPresets[feature];
    if (marker) {
      if (stableStringify(current) === stableStringify(marker)) return;
      profile.managedPresets[feature] = clone(marker);
    } else {
      if (!Object.prototype.hasOwnProperty.call(profile.managedPresets, feature)) return;
      delete profile.managedPresets[feature];
    }
    writeChatPatchRoot(root);
  }


  function setBinding(feature, scope, value) {
    assertBindingScopeAvailable(scope);
    if (!FEATURE_IDS.includes(feature) || !SCOPE_IDS.includes(scope)) {
      throw new Error(`无效绑定: ${feature}/${scope}`);
    }
    if (NATIVE_PRESET_FEATURES.has(feature) && scope !== 'character') {
      throw new Error(`${FEATURE_LABELS[feature]} 的${SCOPE_LABELS[scope]}范围必须写入数据库原生绑定`);
    }
    if (scope === 'chat') {
      const root = readChatPatchRoot();
      const profile = getChatProfile(root, true);
      profile.bindings[feature] = normalizePatchOwnedBindingCore(feature, value);
      profile.bindingOrigins[feature] = 'chat';
      writeChatPatchRoot(root);
      return;
    }
    const state = readState();
    const profile = getProfileState(state, true);
    if (scope === 'global') {
      profile.global[feature] = normalizePatchOwnedBindingCore(feature, value);
    } else {
      const identity = getIdentity();
      if (!identity.characterStable) {
        throw new Error('角色尚未加载完成，无法保存角色绑定；请稍候后重试');
      }
      const root = readCharacterPatchRoot() || { version: 1, profiles: {} };
      const characterProfile = getCharacterPatchProfile(root, true);
      characterProfile.bindings[feature] = normalizePatchOwnedBindingCore(feature, value);
      characterProfile.legacyImported = true;
      writeCharacterPatchRoot(root);
      removeLegacyCharacterBindings();
      return;
    }
    writeState(state);
  }

  function clearBinding(feature, scope) {
    assertBindingScopeAvailable(scope);
    if (NATIVE_PRESET_FEATURES.has(feature) && scope !== 'character') {
      throw new Error(`${FEATURE_LABELS[feature]} 的${SCOPE_LABELS[scope]}范围必须清理数据库原生绑定`);
    }
    if (scope === 'chat') {
      const root = readChatPatchRoot();
      const profile = getChatProfile(root, true);
      delete profile.bindings[feature];
      delete profile.bindingOrigins[feature];
      writeChatPatchRoot(root);
      return;
    }
    const state = readState();
    const profile = getProfileState(state, true);
    if (scope === 'global') {
      delete profile.global[feature];
    } else {
      const identity = getIdentity();
      if (!identity.characterStable) {
        throw new Error('角色尚未加载完成，无法清除角色绑定；请稍候后重试');
      }
      const root = readCharacterPatchRoot() || { version: 1, profiles: {} };
      const characterProfile = getCharacterPatchProfile(root, true);
      delete characterProfile.bindings[feature];
      characterProfile.legacyImported = true;
      writeCharacterPatchRoot(root);
      removeLegacyCharacterBindings();
      return;
    }
    writeState(state);
  }

  async function setNativePresetBinding(feature, scope, value) {
    assertBindingScopeAvailable(scope);
    const initialEpoch = runtime.contextEpoch;
    const initiallyWithoutChat = !getIdentity().chatKey;
    const api = getDatabaseApi();
    const presetName = String(value || '');
    if (feature === 'tablePreset' && scope === 'chat') {
      throw new Error('对话表格模板由数据库管理，请打开数据库修改');
    }
    if (!NATIVE_PRESET_FEATURES.has(feature) || !['global', 'chat'].includes(scope)) {
      throw new Error(`无效原生预设绑定: ${feature}/${scope}`);
    }

    if (feature === 'plotPreset') {
      if (scope === 'global') {
        await mutateDatabaseSettingsViaSave(settings => {
          if (!isObject(settings.plotSettings)) throw new Error('剧情推进设置尚不可用');
          if (String(settings.plotSettings.lastUsedPresetName || '') === presetName) return false;
          settings.plotSettings.lastUsedPresetName = presetName;
          return true;
        });
        return true;
      }
      if (typeof api?.switchPlotPreset !== 'function') throw new Error('数据库缺少 switchPlotPreset API');
      setManagedPreset(feature, null);
      return api.switchPlotPreset(presetName) !== false;
    }

    if (typeof api?.switchTemplatePreset !== 'function') {
      throw new Error('数据库缺少 switchTemplatePreset API');
    }
    if (scope === 'chat') setManagedPreset(feature, null);
    let result = await switchTemplatePresetWithConfirmation(
      api,
      presetName,
      { scope },
      `${SCOPE_LABELS[scope]}${FEATURE_LABELS[feature]}切换`,
    );
    if (scope === 'global' && initiallyWithoutChat && !getIdentity().chatKey && initialEpoch === runtime.contextEpoch
      && result?.success === false
      && /当前聊天元数据尚未就绪/.test(String(result.error || result.message || ''))) {
      result = await saveGlobalTemplateWithoutChat(presetName);
    }
    await captureDatabaseSettings(true);
    return handleTemplatePresetApiResult(
      feature,
      result,
      `${SCOPE_LABELS[scope]}${FEATURE_LABELS[feature]}切换`,
    ).saved;
  }

  async function clearNativePresetBinding(feature, scope) {
    assertBindingScopeAvailable(scope);
    if (scope === 'global') {
      return setNativePresetBinding(feature, 'global', '');
    }

    const api = getDatabaseApi();
    if (feature === 'plotPreset') {
      if (typeof api?.switchPlotPreset !== 'function') throw new Error('数据库缺少 switchPlotPreset API');
      const result = api.switchPlotPreset('');
      setManagedPreset(feature, null);
      return result !== false;
    }

    if (feature === 'tablePreset') {
      throw new Error('对话表格模板由数据库管理，请打开数据库修改');
    }

    throw new Error(`无效原生预设绑定: ${feature}/${scope}`);
  }

  async function setBindingForScope(feature, scope, value) {
    assertBindingScopeAvailable(scope);
    if (NATIVE_PRESET_FEATURES.has(feature) && scope !== 'character') {
      return setNativePresetBinding(feature, scope, value);
    }
    setBinding(feature, scope, value);
    return true;
  }

  async function clearBindingForScope(feature, scope) {
    assertBindingScopeAvailable(scope);
    if (NATIVE_PRESET_FEATURES.has(feature) && scope !== 'character') {
      return clearNativePresetBinding(feature, scope);
    }
    clearBinding(feature, scope);
    return true;
  }

  function isPatchOwnedBindingScope(feature, scope) {
    return !(NATIVE_PRESET_FEATURES.has(feature) && scope !== 'character');
  }

  function assertBindingScopeAvailable(scope) {
    const identity = getIdentity();
    if (!SCOPE_IDS.includes(scope)) throw new Error(`无效绑定范围：${scope}`);
    if (scope === 'chat' && !identity.chatKey) throw new Error('请先打开一条对话，再操作对话绑定');
    if (scope === 'character' && !identity.characterStable) throw new Error('请先选择并加载一个角色，再操作角色绑定');
  }

  async function saveGlobalTemplateWithoutChat(presetName) {
    const epoch = runtime.contextEpoch;
    const profileKey = runtime.databaseProfileKey;
    const assertCurrent = () => {
      if (getIdentity().chatKey || runtime.contextEpoch !== epoch || runtime.databaseProfileKey !== profileKey) {
        throw new Error('操作期间对话或数据库已切换，请重新选择全局预设');
      }
    };
    assertCurrent();
    if (!profileKey?.endsWith('__settings')) throw new Error('数据库全局模板存储结构不可用');
    const api = getDatabaseApi();
    if (presetName && !api?.getTemplatePresetNames?.().includes(presetName)) throw new Error('全局表格预设不存在');
    const template = presetName ? await api.getTableTemplate({ scope: 'global', presetName }) : null;
    if (presetName && (!isObject(template) || !Object.keys(template).some(key => key.startsWith('sheet_')))) {
      throw new Error('无法读取所选全局表格预设');
    }
    assertCurrent();
    const templateKey = profileKey.slice(0, -'settings'.length) + 'template';
    // The native API mistakes welcome messages for a chat. Only save the native
    // profile default here; the database restores its runtime when a real chat opens.
    await mutateDatabaseSettingsViaSave(settings => {
      assertCurrent();
      updateVariablesSafely(variables => {
        assertCurrent();
        const namespace = variables?.[DB_STORAGE_CONTRACT.settingsNamespace];
        const stored = isObject(namespace) && parseStoredJson(namespace[profileKey]);
        if (!isObject(stored)) throw new Error('数据库配置存储不可用');
        const next = {
          ...namespace,
          [profileKey]: JSON.stringify({ ...stored, currentTemplatePresetName: presetName }),
        };
        if (template) next[templateKey] = JSON.stringify(template);
        else delete next[templateKey]; // Native absence means the built-in default.
        return { ...variables, [DB_STORAGE_CONTRACT.settingsNamespace]: next };
      }, { type: 'extension', extension_id: '__userscripts' });
      settings.currentTemplatePresetName = presetName;
      return true;
    });
    assertCurrent();
    return { success: true, saved: true };
  }

  async function runBindingUiAction(action) {
    try { return await action(); } catch (error) {
      runtime.lastError = String(error?.message || error);
      host.toastr?.error?.(runtime.lastError);
      refreshUiStatus();
      return false;
    }
  }

  function bindingAtScopeMatches(feature, scope, expected) {
    const actual = getBindingAtScope(feature, scope);
    return actual !== undefined && controlValuesEquivalentCore(
      feature,
      actual,
      expected,
      runtime.activeWorldbooks.all,
    );
  }

  function setEditScope(feature, scope) {
    if (!FEATURE_IDS.includes(feature) || !SCOPE_IDS.includes(scope)) return;
    runtime.editScopes[feature] = scope;
    const state = readState();
    state.ui.scopes[feature] = scope;
    writeState(state);
  }

  function getEditScope(feature, state = null) {
    return resolveEditScopeCore(
      feature,
      runtime.editScopes,
      (state || readState()).ui.scopes,
    );
  }

  function findDatabaseFrame() {
    const doc = host.document;
    if (!doc?.querySelectorAll) return null;
    return findDatabaseFrameCore(doc.querySelectorAll('iframe'), getDatabaseApi());
  }

  function getDatabaseSourceTag() {
    const frame = findDatabaseFrame();
    if (!frame) return '';
    let source = '';
    try {
      source = String(frame.getAttribute?.('srcdoc') || frame.contentDocument?.documentElement?.innerHTML || '');
    } catch (_) {
      return '';
    }
    return readDatabaseSourceTagCore(source);
  }

  function looksLikeDatabaseSettings(value) {
    return isObject(value)
      && isObject(value.apiConfig)
      && isObject(value.plotSettings)
      && isObject(value.characterSettings)
      && Array.isArray(value.charCardPrompt);
  }

  function parseStoredJson(value) {
    if (isObject(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = JSON.parse(value);
      return isObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function getDatabaseProfileStorageKey(meta) {
    const isolationCode = String(meta?.activeIsolationCode || '').trim();
    const profileSlot = isolationCode ? encodeURIComponent(isolationCode) : '__default__';
    return `${DB_STORAGE_CONTRACT.profilePrefix}__${profileSlot}__settings`;
  }

  function readStoredDatabaseSettings() {
    const namespace = readUserscriptVariables()?.[DB_STORAGE_CONTRACT.settingsNamespace];
    if (!isObject(namespace)) return null;
    const meta = parseStoredJson(namespace[DB_STORAGE_CONTRACT.globalMetaKey]) || {};
    const expectedKey = getDatabaseProfileStorageKey(meta);
    const profileKeys = Object.keys(namespace)
      .filter(key => key.startsWith(`${DB_STORAGE_CONTRACT.profilePrefix}__`)
        && key.endsWith('__settings'));
    const candidates = [
      expectedKey,
      ...(profileKeys.length === 1 ? profileKeys : []),
    ];
    for (const key of uniqueNames(candidates)) {
      const settings = parseStoredJson(namespace[key]);
      if (!looksLikeDatabaseSettings(settings)) continue;
      runtime.databaseProfileKey = key;
      return clone(settings);
    }
    return null;
  }

  async function captureDatabaseSettings(force = false) {
    if (force) runtime.settingsRef = null;
    const stored = readStoredDatabaseSettings();
    if (stored) {
      runtime.settingsRef = stored;
      runtime.lastError = '';
      return stored;
    }
    if (runtime.settingsRef) return runtime.settingsRef;
    const api = getDatabaseApi();
    const frame = findDatabaseFrame();
    if (!api || !frame?.contentWindow) return null;

    runtime.dbFrame = frame;
    const frameWindow = frame.contentWindow;
    runtime.dbFrameWindow = frameWindow;
    runtime.dbApi = api;
    try {
      void frameWindow.JSON.stringify;
    } catch (error) {
      runtime.lastError = `无法访问数据库 iframe: ${error?.message || error}`;
      return null;
    }

    let captured;
    try {
      captured = await captureObjectViaStringify(
        frameWindow.JSON,
        () => {
          if (typeof api.getUpdateConfigParams === 'function' && typeof api.setUpdateConfigParams === 'function') {
            const params = api.getUpdateConfigParams();
            api.setUpdateConfigParams(params);
          }
        },
        looksLikeDatabaseSettings,
        80,
      );
    } catch (error) {
      runtime.lastError = `捕获数据库设置失败: ${error?.message || error}`;
    }

    if (captured) {
      if (runtime.settingsGeneration === 0) runtime.settingsGeneration = 1;
      runtime.settingsRef = captured;
      runtime.lastError = '';
      log('已连接数据库运行时设置。');
    } else if (!runtime.lastError) {
      runtime.lastError = (
        typeof api.getUpdateConfigParams !== 'function'
        || typeof api.setUpdateConfigParams !== 'function'
      )
        ? '数据库缺少 getUpdateConfigParams/setUpdateConfigParams API'
        : '数据库保存时未发现兼容的 settings_ACU 结构';
    }
    return runtime.settingsRef;
  }

  async function mutateDatabaseSettingsViaSave(mutator) {
    const api = getDatabaseApi();
    const frame = findDatabaseFrame();
    if (!api || !frame?.contentWindow) throw new Error('数据库运行时尚不可用');
    if (
      typeof api.getUpdateConfigParams !== 'function'
      || typeof api.setUpdateConfigParams !== 'function'
    ) {
      throw new Error('数据库缺少 getUpdateConfigParams/setUpdateConfigParams API');
    }

    runtime.dbFrame = frame;
    runtime.dbFrameWindow = frame.contentWindow;
    runtime.dbApi = api;
    let mutationChanged = false;
    let captured = null;
    try {
      captured = await captureObjectViaStringify(
        frame.contentWindow.JSON,
        () => api.setUpdateConfigParams(api.getUpdateConfigParams()),
        looksLikeDatabaseSettings,
        80,
        settings => {
          const result = mutator(settings);
          if (result && typeof result.then === 'function') {
            throw new Error('数据库保存期间的设置修改必须同步完成');
          }
          mutationChanged = result !== false;
        },
      );
    } catch (error) {
      if (error?.code === 'SJBP_CONTEXT_CHANGED') throw error;
      throw new Error(`通过数据库保存设置失败: ${error?.message || error}`);
    }
    if (!captured) throw new Error('数据库保存时未发现当前 settings_ACU 对象');
    runtime.settingsRef = captured;
    runtime.lastError = '';
    return { settings: captured, changed: mutationChanged };
  }

  async function migrateLegacyPresetBindings() {
    const legacyGlobal = {};
    const legacyChat = {};
    let stateChanged = false;
    let chatChanged = false;

    const state = readState();
    const profile = getProfileState(state, false);
    for (const feature of NATIVE_PRESET_FEATURES) {
      if (Object.prototype.hasOwnProperty.call(profile.global, feature)) {
        legacyGlobal[feature] = clone(profile.global[feature]);
        delete profile.global[feature];
        stateChanged = true;
      }
    }
    if (stateChanged) writeState(state);

    const root = readChatPatchRoot();
    const chatProfile = getChatProfile(root, false);
    for (const feature of NATIVE_PRESET_FEATURES) {
      // Keep obsolete patch-owned table bindings for recovery, but never replay them into the database.
      if (feature === 'tablePreset') continue;
      if (Object.prototype.hasOwnProperty.call(chatProfile.bindings, feature)) {
        legacyChat[feature] = clone(chatProfile.bindings[feature]);
        delete chatProfile.bindings[feature];
        chatChanged = true;
      }
    }
    if (chatChanged) writeChatPatchRoot(root);

    for (const [feature, value] of Object.entries(legacyGlobal)) {
      await setNativePresetBinding(feature, 'global', value);
    }
    for (const [feature, value] of Object.entries(legacyChat)) {
      await setNativePresetBinding(feature, 'chat', value);
    }

    if (stateChanged || chatChanged) {
      log('已将旧补丁的预设全局/对话绑定迁移到数据库原生存储。');
    }
    return stateChanged || chatChanged;
  }

  function normalizeActiveSources(raw) {
    return normalizeActiveSourcesCore(raw);
  }

  function readSupplementalSources() {
    let persona = '';
    let personaAvatar = '';
    try {
      if (typeof getPersona === 'function') {
        const currentPersona = getPersona('current');
        persona = String(currentPersona?.lorebook || '').trim();
        personaAvatar = String(currentPersona?.avatar_id || '').trim();
      } else if (typeof getCurrentPersonaId === 'function') {
        personaAvatar = String(getCurrentPersonaId() || '').trim();
      }
    } catch (_) {
      // The helper reports no current persona while the chat is still loading.
    }
    return {
      persona,
      personaAvatar,
    };
  }

  function readHelperSources(supplemental = {}) {
    let available = [];
    let global = [];
    let character = { primary: '', additional: [] };
    let chat = [];
    try {
      if (typeof getWorldbookNames === 'function') available = getWorldbookNames();
    } catch (_) {
      // Other documented helper sources can still be used.
    }
    try {
      if (typeof getGlobalWorldbookNames === 'function') global = getGlobalWorldbookNames();
    } catch (_) {
      // Other documented helper sources can still be used.
    }
    try {
      if (typeof getCharWorldbookNames === 'function') character = getCharWorldbookNames('current') || character;
    } catch (_) {
      // Other documented helper sources can still be used.
    }
    try {
      if (typeof getChatWorldbookName === 'function') {
        const value = getChatWorldbookName('current');
        chat = Array.isArray(value) ? value : [value];
      }
    } catch (_) {
      // Other documented helper sources can still be used.
    }
    return normalizeActiveSources({
      global,
      characterPrimary: character.primary,
      characterAdditional: character.additional,
      chat: uniqueNames([...chat, ...(supplemental.chat || [])]),
      persona: supplemental.persona || '',
      personaAvatar: supplemental.personaAvatar || '',
      available,
    });
  }

  async function refreshActiveWorldbooks() {
    runtime.activeWorldbooks = readHelperSources(readSupplementalSources());
    return runtime.activeWorldbooks;
  }

  function getTableWorldbookConfig(settings, chatKey, create = false) {
    if (!settings || !chatKey) return null;
    const scopeKey = databaseWorldbookScopeKeyCore(settings, { ...getIdentity(), chatKey }, getDatabaseSourceTag());
    if (!isObject(settings.characterSettings)) {
      if (!create) return null;
      settings.characterSettings = {};
    }
    if (!isObject(settings.characterSettings[scopeKey])) {
      if (!create) return null;
      const legacy = settings.characterSettings[chatKey];
      settings.characterSettings[scopeKey] = scopeKey !== chatKey && isObject(legacy?.worldbookConfig)
        ? clone(legacy)
        : {};
    }
    if (!isObject(settings.characterSettings[scopeKey].worldbookConfig)) {
      if (!create) return null;
      settings.characterSettings[scopeKey].worldbookConfig = {
        source: 'character',
        manualSelection: [],
        enabledEntries: {},
        injectionTarget: 'character',
      };
    }
    return settings.characterSettings[scopeKey].worldbookConfig;
  }

  function getPlotWorldbookConfig(settings, create = false) {
    if (!settings) return null;
    if (!isObject(settings.plotSettings)) {
      if (!create) return null;
      settings.plotSettings = {};
    }
    if (!isObject(settings.plotSettings.plotWorldbookConfig)) {
      if (!create) return null;
      settings.plotSettings.plotWorldbookConfig = {
        source: 'character',
        manualSelection: [],
        enabledEntries: {},
      };
    }
    return settings.plotSettings.plotWorldbookConfig;
  }

  function assignConfigIfChanged(config, nextConfig) {
    if (!isObject(config) || !isObject(nextConfig)) return false;
    if (stableStringify(config) === stableStringify(nextConfig)) return false;
    Object.assign(config, nextConfig);
    return true;
  }

  function normalizeInjectionTarget(value) {
    return String(value || '').trim() || 'character';
  }

  function getVisibleDatabaseRoot() {
    const root = host.document?.getElementById(DB_UI_CONTRACT.rootId);
    if (
      !root
      || root.classList.contains('sjbp-headless')
      || host.getComputedStyle(root).display === 'none'
    ) return null;
    return root;
  }

  function readDatabaseUiWorldbookConfig(page) {
    const picker = page?.querySelector(DB_UI_CONTRACT.sourcePicker);
    if (!picker) return null;
    const activeSourceButton = picker.querySelector('[data-sjbp-source-active]');
    const manualButton = findDatabaseControl(
      picker,
      `${DB_UI_CONTRACT.segmentedItem}:not([data-sjbp-source-active])`,
      DB_UI_CONTRACT.labels.manual,
    );
    const materializedActive = activeSourceButton?.getAttribute('aria-checked') === 'true';
    return {
      source: (
        manualButton?.getAttribute('aria-checked') === 'true'
        || materializedActive
      ) ? 'manual' : 'character',
      manualSelection: [...picker.querySelectorAll('[role="checkbox"]')]
        .filter(button => button.getAttribute('aria-checked') === 'true')
        .map(button => String(button.textContent || '').trim()),
    };
  }

  function readDatabaseUiInjectionTarget(page) {
    const text = String(
      page?.querySelector(DB_UI_CONTRACT.injectionTrigger)?.textContent || '',
    ).trim();
    if (!text) return '';
    return text === DB_UI_CONTRACT.labels.characterTarget ? 'character' : text;
  }

  function databaseWorldbookConfigMatches(actual, expected) {
    if (!actual || !expected) return false;
    return (
      (actual.source === 'manual' ? 'manual' : 'character')
        === (expected.source === 'manual' ? 'manual' : 'character')
      && stableStringify(sortedNames(actual.manualSelection))
        === stableStringify(sortedNames(expected.manualSelection))
    );
  }

  async function waitForDatabaseElement(selector, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const element = host.document?.querySelector(selector);
      if (element) return element;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  }

  function findDatabaseSidebarButton(root, label) {
    return [...(root?.querySelectorAll?.(DB_UI_CONTRACT.sidebarItem) || [])]
      .find(button => String(button.textContent || '').trim() === label) || null;
  }

  function findDatabaseControl(root, selector, label) {
    return [...(root?.querySelectorAll?.(selector) || [])]
      .find(element => String(element.textContent || '').trim() === label) || null;
  }

  async function waitForDatabaseCondition(predicate, errorMessage, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(errorMessage);
  }

  async function refreshVisibleDatabaseWorldbookPage(features) {
    let root = getVisibleDatabaseRoot();
    if (!root) return false;
    const activeButton = root.querySelector(DB_UI_CONTRACT.sidebarActive);
    const activeLabel = String(activeButton?.textContent || '').trim();
    const feature = activeLabel === DB_UI_CONTRACT.labels.table
      ? 'tableWorldbooks'
      : (activeLabel === DB_UI_CONTRACT.labels.plot ? 'plotWorldbooks' : '');
    if (!feature || !features.has(feature)) return false;

    const originalButton = findDatabaseSidebarButton(root, activeLabel);
    const alternateButton = [...root.querySelectorAll(DB_UI_CONTRACT.sidebarItem)]
      .find(button => button !== originalButton
        && !button.matches(DB_UI_CONTRACT.sidebarActive));
    if (!originalButton || !alternateButton) return false;

    alternateButton.click();
    await waitForDatabaseCondition(
      () => {
        root = getVisibleDatabaseRoot();
        return String(root?.querySelector(DB_UI_CONTRACT.sidebarActive)?.textContent || '').trim()
          !== activeLabel;
      },
      `数据库页面未能离开: ${activeLabel}`,
      3000,
    );
    findDatabaseSidebarButton(root, activeLabel)?.click();
    const selector = feature === 'tableWorldbooks'
      ? DB_UI_CONTRACT.tablePage
      : DB_UI_CONTRACT.plotPage;
    await waitForDatabaseCondition(
      () => !!getVisibleDatabaseRoot()?.querySelector(`${selector} ${DB_UI_CONTRACT.sourcePicker}`),
      `数据库页面未能重新载入: ${activeLabel}`,
      4000,
    );
    return true;
  }

  function captureBindingContext() {
    return {
      chatKey: getIdentity().chatKey,
      epoch: runtime.contextEpoch,
      signal: runtime.contextController.signal,
    };
  }

  function isBindingContextCurrent(context) {
    return !context.signal?.aborted && isBindingContextCurrentCore(context, {
      chatKey: getIdentity().chatKey,
      epoch: runtime.contextEpoch,
      started: runtime.started,
    });
  }

  function assertBindingContextCurrent(context) {
    if (isBindingContextCurrent(context)) return;
    const error = new Error('对话已切换、关闭或数据库已重载，取消旧同步任务');
    error.code = 'SJBP_CONTEXT_CHANGED';
    throw error;
  }

  function invalidateBindingContext() {
    runtime.contextEpoch += 1;
    runtime.contextController.abort();
    runtime.contextController = new AbortController();
    clearTimeout(runtime.applyTimer);
    clearTimeout(runtime.postCaptureReapplyTimer);
    runtime.postCaptureRefreshWriteWorldbook = false;
    runtime.postCaptureResetWriteWorldbook = false;
    runtime.postCaptureRetryAttempt = 0;
    runtime.pendingWriteWorldbookTransition = null;
  }

  function waitForWorldbookApiPromise(promise, label, context, timeoutMs, operation = '写入世界书') {
    assertBindingContextCurrent(context);
    let cleanup = () => {};
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        try { assertBindingContextCurrent(context); } catch (error) { reject(error); }
      };
      const timer = setTimeout(
        () => reject(new Error(`数据库${operation}操作超时: ${label}（原调用可能仍在执行）`)),
        timeoutMs,
      );
      context.signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(resolve, reject);
      // Cleanup also runs when cancellation wins before the upstream API settles.
      cleanup = () => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
      };
    }).finally(() => cleanup());
  }

  async function waitForWorldbookApiIdle(context) {
    while (runtime.worldbookApiPending) {
      await waitForWorldbookApiPromise(
        runtime.worldbookApiPending.catch(() => undefined),
        '等待上次调用结束', context, DATABASE_WORLDBOOK_API_TIMEOUT_MS,
      );
      assertBindingContextCurrent(context);
    }
  }

  async function callDatabaseWorldbookApiWithTimeout(
    callback, label, context = captureBindingContext(), timeoutMs = DATABASE_WORLDBOOK_API_TIMEOUT_MS,
  ) {
    while (runtime.worldbookApiPending) await waitForWorldbookApiIdle(context);
    assertBindingContextCurrent(context);
    const pending = Promise.resolve().then(() => {
      assertBindingContextCurrent(context);
      return callback();
    });
    runtime.worldbookApiPending = pending;
    const release = () => {
      if (runtime.worldbookApiPending === pending) runtime.worldbookApiPending = null;
    };
    void pending.then(release, release);
    const result = await waitForWorldbookApiPromise(pending, label, context, timeoutMs);
    assertBindingContextCurrent(context);
    return result;
  }

  async function refreshWriteWorldbookViaDatabase(reason, context = captureBindingContext()) {
    assertBindingContextCurrent(context);
    const binding = resolveBinding('writeWorldbook');
    if (!binding) return false;
    const api = getDatabaseApi();
    let method = '';
    let result;
    if (typeof api?.syncWorldbookEntries === 'function') {
      method = 'syncWorldbookEntries';
      result = await callDatabaseWorldbookApiWithTimeout(
        () => api.syncWorldbookEntries({ createIfNeeded: true }),
        method, context,
      );
    } else if (typeof api?.refreshDataAndWorldbook === 'function') {
      method = 'refreshDataAndWorldbook';
      result = await callDatabaseWorldbookApiWithTimeout(
        () => api.refreshDataAndWorldbook(),
        method, context,
      );
    } else {
      throw new Error('数据库缺少写入世界书刷新 API');
    }
    if (result === false) {
      throw new Error(`数据库写入世界书刷新失败: ${method}`);
    }
    runtime.lastWriteWorldbookRefresh = {
      chatKey: getIdentity().chatKey,
      target: String(binding.value || 'character'),
      method,
      reason,
      at: Date.now(),
    };
    return true;
  }

  function installDatabaseTableUpdateMonitor() {
    const api = getDatabaseApi();
    if (runtime.databaseTableCallbackApi === api && runtime.databaseTableCallback) return true;
    if (runtime.databaseTableCallbackApi && runtime.databaseTableCallback) {
      try {
        runtime.databaseTableCallbackApi.unregisterTableUpdateCallback?.(
          runtime.databaseTableCallback,
        );
      } catch (_) {
        // Ignore cleanup failures from a replaced database runtime.
      }
    }
    runtime.databaseTableCallback = null;
    runtime.databaseTableCallbackApi = null;
    if (typeof api?.registerTableUpdateCallback !== 'function') return false;
    const callback = (tableData, meta) => {
      if (!isPersistedDatabaseTableUpdateCore(meta)) {
        runtime.databaseTableUnpersistedAt = Date.now();
        return;
      }
      runtime.databaseTableRevision += 1;
      runtime.databaseTableUpdatedAt = Date.now();
      runtime.databaseTableDataState = classifyDatabaseTableDataCore(tableData);
    };
    api.registerTableUpdateCallback(callback);
    runtime.databaseTableCallback = callback;
    runtime.databaseTableCallbackApi = api;
    return true;
  }

  function beginWriteWorldbookTransition(reason) {
    if (!getIdentity().chatKey) return null;
    installDatabaseTableUpdateMonitor();
    const requestedAt = Date.now();
    runtime.pendingWriteWorldbookTransition = {
      chatKey: getIdentity().chatKey,
      settingsGeneration: runtime.settingsGeneration,
      baselineRevision: runtime.databaseTableRevision,
      requestedAt,
      notBefore: requestedAt + DATABASE_CHAT_READY_MIN_DELAY_MS,
      reason,
    };
    return runtime.pendingWriteWorldbookTransition;
  }

  function databaseTableReadyForTransition(transition) {
    return isDatabaseTransitionReadyCore({
      transition,
      currentSettingsGeneration: runtime.settingsGeneration,
      currentChatKey: getIdentity().chatKey,
      currentRevision: runtime.databaseTableRevision,
      updatedAt: runtime.databaseTableUpdatedAt,
    });
  }

  async function waitForDatabaseTableReady(
    transition, context = captureBindingContext(), timeoutMs = DATABASE_TABLE_READY_TIMEOUT_MS,
  ) {
    assertBindingContextCurrent(context);
    if (!transition) return 'unknown';
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      assertBindingContextCurrent(context);
      installDatabaseTableUpdateMonitor();
      if (databaseTableReadyForTransition(transition)
        && Date.now() >= transition.requestedAt + DATABASE_CHAT_SETTLE_DELAY_MS
        && (runtime.databaseTableUnpersistedAt || 0) <= runtime.databaseTableUpdatedAt
        && Date.now() - runtime.databaseTableUpdatedAt >= 300) {
        return runtime.databaseTableDataState;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('数据库尚未完成当前对话表格初始化；等待重试同步');
  }

  async function performWriteWorldbookReset(reason, context = captureBindingContext()) {
    assertBindingContextCurrent(context);
    const transition = runtime.pendingWriteWorldbookTransition;
    const api = getDatabaseApi();
    if (typeof api?.deleteInjectedEntries !== 'function') {
      throw new Error('数据库缺少 deleteInjectedEntries API');
    }
    const deleted = await callDatabaseWorldbookApiWithTimeout(
      () => api.deleteInjectedEntries(),
      'deleteInjectedEntries', context,
    );
    if (deleted === false) throw new Error('数据库清空当前写入世界书失败');

    const tableDataState = await waitForDatabaseTableReady(transition, context);
    assertBindingContextCurrent(context);
    let refreshed = false;
    if (transition && !transition.manualApproved && tableDataState === 'cleared') {
      const binding = resolveBinding('writeWorldbook');
      runtime.lastWriteWorldbookRefresh = {
        chatKey: getIdentity().chatKey,
        target: String(binding?.value || 'character'),
        method: 'deleteInjectedEntries+database-empty',
        reason,
        cleanup: true,
        at: Date.now(),
      };
    } else {
      refreshed = await refreshWriteWorldbookViaDatabase(reason, context);
    }
    if (refreshed && runtime.lastWriteWorldbookRefresh) {
      runtime.lastWriteWorldbookRefresh = {
        ...runtime.lastWriteWorldbookRefresh,
        method: `deleteInjectedEntries+${runtime.lastWriteWorldbookRefresh.method}`,
        cleanup: true,
      };
    }
    if (
      transition
      && runtime.pendingWriteWorldbookTransition === transition
      && databaseTableReadyForTransition(transition)
    ) {
      runtime.pendingWriteWorldbookTransition = null;
      runtime.postCaptureRefreshWriteWorldbook = false;
      runtime.postCaptureResetWriteWorldbook = false;
    }
    return refreshed || deleted;
  }

  function resetWriteWorldbookViaDatabase(reason, { notifyIfBusy = false, context = captureBindingContext() } = {}) {
    assertBindingContextCurrent(context);
    if (runtime.writeWorldbookResetPromise) {
      if (notifyIfBusy) host.toastr?.info?.('写入世界书清空同步已在进行中');
      return runtime.writeWorldbookResetPromise;
    }

    const startedAt = Date.now();
    runtime.writeWorldbookResetState = {
      status: 'running',
      reason,
      startedAt,
    };
    host.toastr?.info?.(`开始清空并同步写入世界书：${reason}`);
    refreshUiStatus();

    const transaction = performWriteWorldbookReset(reason, context)
      .then(result => {
        assertBindingContextCurrent(context);
        runtime.writeWorldbookResetState = {
          status: 'success',
          reason,
          startedAt,
          finishedAt: Date.now(),
        };
        host.toastr?.success?.(`写入世界书清空同步完成：${reason}`);
        return result;
      })
      .catch(error => {
        if (error?.code === 'SJBP_CONTEXT_CHANGED') {
          runtime.writeWorldbookResetState = {
            status: 'cancelled', reason, startedAt, finishedAt: Date.now(),
          };
          if (runtime.started) host.toastr?.info?.('已取消旧对话的写入世界书同步');
          throw error;
        }
        runtime.writeWorldbookResetState = {
          status: 'failed',
          reason,
          error: String(error?.message || error),
          startedAt,
          finishedAt: Date.now(),
        };
        host.toastr?.error?.(`写入世界书清空同步失败：${error?.message || error}`);
        throw error;
      })
      .finally(() => {
        if (runtime.writeWorldbookResetPromise === transaction) {
          runtime.writeWorldbookResetPromise = null;
        }
        refreshUiStatus();
      });
    runtime.writeWorldbookResetPromise = transaction;
    return transaction;
  }

  async function applyWorldbookBindings(forceUiSync = false, context = captureBindingContext(), deferWriteRefresh = false) {
    assertBindingContextCurrent(context);
    if (runtime.pendingWriteWorldbookTransition
      && usesCharacterWorldbookSettingsCore(runtime.settingsRef, getDatabaseSourceTag())) {
      await waitForDatabaseTableReady(runtime.pendingWriteWorldbookTransition, context);
      assertBindingContextCurrent(context);
      await captureDatabaseSettings(true);
      assertBindingContextCurrent(context);
    }
    const settings = runtime.settingsRef;
    const identity = getIdentity();
    if (!settings || !identity.chatKey) {
      return { changed: false, targetChanged: false, writeWorldbookRefreshed: false };
    }
    const active = readHelperSources(readSupplementalSources());
    runtime.activeWorldbooks = active;
    const tableConfig = getTableWorldbookConfig(settings, identity.chatKey, true);
    const writeBinding = resolveBinding('writeWorldbook');
    const oldTarget = normalizeInjectionTarget(tableConfig.injectionTarget);
    const newTarget = writeBinding && typeof writeBinding.value === 'string'
      ? normalizeInjectionTarget(writeBinding.value)
      : oldTarget;
    const root = getVisibleDatabaseRoot();
    const tablePage = root?.querySelector(DB_UI_CONTRACT.tablePage);
    const plotPage = root?.querySelector(DB_UI_CONTRACT.plotPage);
    const tableUiConfig = readDatabaseUiWorldbookConfig(tablePage);
    const plotUiConfig = readDatabaseUiWorldbookConfig(plotPage);
    const targetChanged = oldTarget !== newTarget;

    const tableBinding = resolveBinding('tableWorldbooks');
    const plotBinding = resolveBinding('plotWorldbooks');
    const tableDesired = tableBinding && isObject(tableBinding.value)
      ? materializeWorldbookSource(tableConfig, tableBinding.value, active.all)
      : tableConfig;
    const plotConfig = getPlotWorldbookConfig(settings, true);
    const plotDesired = plotBinding && isObject(plotBinding.value)
      ? materializeWorldbookSource(plotConfig, plotBinding.value, active.all)
      : plotConfig;
    const tableSettingsChanged = (
      tableConfig.source !== tableDesired.source
      || stableStringify(sortedNames(tableConfig.manualSelection))
        !== stableStringify(sortedNames(tableDesired.manualSelection))
    );
    const plotSettingsChanged = (
      plotConfig.source !== plotDesired.source
      || stableStringify(sortedNames(plotConfig.manualSelection))
        !== stableStringify(sortedNames(plotDesired.manualSelection))
      || (usesCharacterWorldbookSettingsCore(settings, getDatabaseSourceTag())
        && !!identity.databaseCharacterKey
        && stableStringify(settings.plotWorldbookConfigByCharacter?.[identity.databaseCharacterKey])
          !== stableStringify(plotDesired))
    );
    const tableUiChanged = !!tableBinding
      && !!tableUiConfig
      && !databaseWorldbookConfigMatches(tableUiConfig, tableDesired);
    const plotUiChanged = !!plotBinding
      && !!plotUiConfig
      && !databaseWorldbookConfigMatches(plotUiConfig, plotDesired);
    const tableSourceChanged = !!tableBinding
      && tableSettingsChanged;
    const plotSourceChanged = !!plotBinding
      && plotSettingsChanged;
    const uiRefreshFeatures = new Set();
    if (tableBinding && (tableUiChanged || (forceUiSync && !!tableUiConfig))) {
      uiRefreshFeatures.add('tableWorldbooks');
    }
    if (plotBinding && (plotUiChanged || (forceUiSync && !!plotUiConfig))) {
      uiRefreshFeatures.add('plotWorldbooks');
    }
    const changed = targetChanged || tableSourceChanged || plotSourceChanged;
    if (!changed && !uiRefreshFeatures.size) {
      return { changed: false, targetChanged: false, writeWorldbookRefreshed: false };
    }

    runtime.databaseUiDriving = true;
    let cleanupSucceeded = false;
    let writeWorldbookRefreshed = false;
    try {
      if (targetChanged) {
        const api = getDatabaseApi();
        if (typeof api?.deleteInjectedEntries !== 'function') {
          throw new Error('数据库缺少 deleteInjectedEntries API');
        }
        cleanupSucceeded = await callDatabaseWorldbookApiWithTimeout(
          () => api.deleteInjectedEntries(), 'deleteInjectedEntries（旧目标）', context,
        ) !== false;
        if (!cleanupSucceeded) throw new Error(`数据库清理旧写入目标失败: ${oldTarget}`);
        uiRefreshFeatures.add('tableWorldbooks');
      }

      if (tableSourceChanged) uiRefreshFeatures.add('tableWorldbooks');
      if (plotSourceChanged) uiRefreshFeatures.add('plotWorldbooks');
      if (targetChanged || tableSourceChanged || plotSourceChanged) {
        const saved = await mutateDatabaseSettingsViaSave(currentSettings => {
          assertBindingContextCurrent(context);
          let sourceConfigChanged = false;
          if (targetChanged) {
            const currentTableConfig = getTableWorldbookConfig(
              currentSettings,
              identity.chatKey,
              true,
            );
            if (normalizeInjectionTarget(currentTableConfig.injectionTarget) !== newTarget) {
              currentTableConfig.injectionTarget = newTarget;
              sourceConfigChanged = true;
            }
          }
          if (tableBinding) {
            const currentTableConfig = getTableWorldbookConfig(
              currentSettings,
              identity.chatKey,
              true,
            );
            const currentTableDesired = materializeWorldbookSource(
              currentTableConfig,
              tableBinding.value,
              active.all,
            );
            sourceConfigChanged = (
              applyWorldbookConfigAtomic(currentTableConfig, currentTableDesired)
              || sourceConfigChanged
            );
          }
          if (plotBinding) {
            const currentPlotConfig = getPlotWorldbookConfig(currentSettings, true);
            const currentPlotDesired = materializeWorldbookSource(
              currentPlotConfig,
              plotBinding.value,
              active.all,
            );
            sourceConfigChanged = (
              applyWorldbookConfigAtomic(currentPlotConfig, currentPlotDesired)
              || sourceConfigChanged
            );
            // spv9.2.3 projects this store before stringify; update both copies in this save.
            sourceConfigChanged = syncPlotWorldbookStoreCore(currentSettings, identity, getDatabaseSourceTag())
              || sourceConfigChanged;
          }
          return sourceConfigChanged;
        });
        assertBindingContextCurrent(context);
        runtime.settingsRef = saved.settings;
      }
      if (targetChanged && !deferWriteRefresh) {
        await refreshWriteWorldbookViaDatabase('写入世界书目标切换', context);
        writeWorldbookRefreshed = true;
      }
      if (uiRefreshFeatures.size) {
        assertBindingContextCurrent(context);
        await refreshVisibleDatabaseWorldbookPage(uiRefreshFeatures);
      }
    } finally {
      runtime.databaseUiDriving = false;
      syncDatabaseUi();
    }
    if (targetChanged) {
      runtime.lastWorldbookTransition = {
        chatKey: identity.chatKey,
        oldTarget,
        newTarget,
        cleanupSucceeded,
        syncSucceeded: writeWorldbookRefreshed,
        via: 'database-deleteInjectedEntries/settings-save/syncWorldbookEntries',
        at: Date.now(),
      };
    }
    return { changed, targetChanged, writeWorldbookRefreshed };
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (!isObject(value)) return JSON.stringify(value);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  function getVerificationReport() {
    const identity = getIdentity();
    if (!identity.chatKey) {
      return { ok: true, deferred: true, matched: 0, total: 0, features: {},
        message: '未打开对话；可保存全局或角色绑定，进入对话后核验实际生效状态' };
    }
    const tableConfig = getTableWorldbookConfig(runtime.settingsRef, identity.chatKey, false) || {};
    const plotConfig = getPlotWorldbookConfig(runtime.settingsRef, false) || {};
    const root = getVisibleDatabaseRoot();
    const tableUiConfig = readDatabaseUiWorldbookConfig(root?.querySelector(DB_UI_CONTRACT.tablePage));
    const plotUiConfig = readDatabaseUiWorldbookConfig(root?.querySelector(DB_UI_CONTRACT.plotPage));
    const tableUiTarget = readDatabaseUiInjectionTarget(root?.querySelector(DB_UI_CONTRACT.tablePage));
    const active = runtime.activeWorldbooks.all;
    const features = {};

    const writeBinding = resolveBinding('writeWorldbook');
    const expectedTarget = writeBinding
      ? normalizeInjectionTarget(writeBinding.value)
      : normalizeInjectionTarget(tableConfig.injectionTarget);
    const actualTarget = normalizeInjectionTarget(tableUiTarget || tableConfig.injectionTarget);
    features.writeWorldbook = {
      expected: expectedTarget,
      actual: actualTarget,
      matches: expectedTarget === actualTarget,
    };

    for (const [feature, config] of [
      ['tableWorldbooks', tableConfig],
      ['plotWorldbooks', plotConfig],
    ]) {
      const uiConfig = feature === 'tableWorldbooks' ? tableUiConfig : plotUiConfig;
      const binding = resolveBinding(feature);
      const materialized = binding
        ? materializeWorldbookSource(config, binding.value, active)
        : config;
      const expected = {
        source: materialized?.source === 'manual' ? 'manual' : 'character',
        manualSelection: uniqueNames(materialized?.manualSelection),
        enabledEntries: isObject(materialized?.enabledEntries) ? clone(materialized.enabledEntries) : {},
      };
      const actual = {
        source: (uiConfig || config)?.source === 'manual' ? 'manual' : 'character',
        manualSelection: uniqueNames((uiConfig || config)?.manualSelection),
        enabledEntries: isObject(config?.enabledEntries) ? clone(config.enabledEntries) : {},
      };
      const actualSelectedEntries = Object.fromEntries(
        Object.keys(expected.enabledEntries).map(bookName => [
          bookName,
          Array.isArray(actual.enabledEntries[bookName]) ? actual.enabledEntries[bookName] : [],
        ]),
      );
      features[feature] = {
        expected,
        actual,
        sourceMode: binding?.value?.source || actual.source,
        matches: (
          expected.source === actual.source
          && stableStringify(sortedNames(expected.manualSelection))
            === stableStringify(sortedNames(actual.manualSelection))
          && stableStringify(expected.enabledEntries)
            === stableStringify(actualSelectedEntries)
        ),
      };
    }

    const plotBinding = resolveBinding('plotPreset');
    const expectedPlotPreset = String(plotBinding?.value || '');
    const actualPlotPreset = String(getDatabaseApi()?.getCurrentPlotPreset?.() || '');
    features.plotPreset = {
      expected: expectedPlotPreset,
      actual: actualPlotPreset,
      matches: expectedPlotPreset === actualPlotPreset,
    };

    const tableBinding = resolveBinding('tablePreset');
    const expectedTablePreset = getTablePresetBindingNameCore(tableBinding?.value);
    const actualTablePreset = String(getCurrentTablePresetName() || '');
    const nativeTable = getNativeTablePresetState();
    let tableRuntimeApplied = null;
    if (nativeTable && typeof getDatabaseApi()?.exportTableAsJson === 'function') {
      tableRuntimeApplied = tableTemplateMatchesRuntimeCore(
        nativeTable.templateStr, getDatabaseApi().exportTableAsJson(),
      );
    }
    features.tablePreset = {
      expected: expectedTablePreset,
      actual: actualTablePreset,
      runtimeApplied: tableRuntimeApplied,
      managedBy: nativeTable ? 'database' : 'inheritance',
      matches: expectedTablePreset === actualTablePreset && tableRuntimeApplied !== false,
    };

    const values = Object.values(features);
    const matched = values.filter(item => item.matches).length;
    return {
      ok: matched === values.length,
      matched,
      total: values.length,
      features,
      lastWorldbookTransition: clone(runtime.lastWorldbookTransition),
    };
  }

  function describeVerificationFailures(verification) {
    return Object.entries(verification?.features || {})
      .filter(([, result]) => !result.matches)
      .map(([feature]) => FEATURE_LABELS[feature] || feature);
  }

  function buildApplySignature() {
    const identity = getIdentity();
    return stableStringify({
      isolation: getIsolationKey(),
      chat: identity.chatKey,
      character: identity.characterKey,
      active: runtime.activeWorldbooks.all,
      bindings: Object.fromEntries(FEATURE_IDS.map(feature => [feature, resolveBinding(feature)])),
    });
  }

  async function restoreNativeChatPreset(feature, nativeChat) {
    // Table snapshots and their runtime recovery belong exclusively to the database.
    if (feature === 'tablePreset') return false;
    const api = getDatabaseApi();
    const expectedToken = buildNativePresetApplyToken(feature, nativeChat);
    if (!needsNativePresetRestoreCore(
      feature, nativeChat, String(api?.getCurrentPlotPreset?.() || ''),
      runtime.nativePresetAppliedTokens[feature], expectedToken,
    )) return false;
    if (typeof api?.switchPlotPreset !== 'function') throw new Error('数据库缺少 switchPlotPreset API');
    if (api.switchPlotPreset(String(nativeChat.value || '')) === false) {
      throw new Error(`剧情推进对话预设恢复失败: ${nativeChat.value || '跟随全局'}`);
    }
    runtime.nativePresetAppliedTokens[feature] = expectedToken;
    return true;
  }

  async function runTableTemplateOperation(operation, context = captureBindingContext()) {
    assertBindingContextCurrent(context);
    if (runtime.nativeTemplateRestorePending) {
      throw new Error('上一次表格模板操作仍在执行；不会重复提交，请等待数据库完成');
    }
    const pending = Promise.resolve().then(() => {
      assertBindingContextCurrent(context);
      return operation();
    });
    runtime.nativeTemplateRestorePending = pending;
    const release = () => {
      if (runtime.nativeTemplateRestorePending === pending) runtime.nativeTemplateRestorePending = null;
    };
    // Release our wait on cancellation, but never pretend the upstream transaction was cancelled.
    void pending.then(release, release);
    const result = await waitForWorldbookApiPromise(
      pending, 'templateOperation', context, DATABASE_TEMPLATE_RESTORE_TIMEOUT_MS, '表格模板',
    );
    assertBindingContextCurrent(context);
    return result;
  }

  function getTemplateSnapshotFromDatabase(source) {
    if (source?.type === 'embedded') {
      return parseTemplateSnapshotCore(
        source.template,
        source?.label || source?.name || '角色内嵌模板',
      );
    }
    const api = getDatabaseApi();
    if (typeof api?.getTableTemplate !== 'function') {
      throw new Error('数据库缺少 getTableTemplate API');
    }
    const options = source?.type === 'preset'
      ? { scope: 'global', presetName: source.name }
      : { scope: source?.type === 'chat' ? 'chat' : 'global' };
    const template = api.getTableTemplate(options);
    return parseTemplateSnapshotCore(template, source?.label || source?.name || '模板');
  }

  function buildMergedTemplateLabel(sources) {
    const labels = sources.map(source => String(source?.label || source?.name || '模板').trim());
    const joined = labels.join(' → ');
    return joined.length <= 120 ? `合并：${joined}` : `合并模板（${labels.length} 项）`;
  }

  async function applyMergedTemplateSourcesToCurrentChat(sources, context, onlyIfMissing = false) {
    assertBindingScopeAvailable('chat');
    const api = getDatabaseApi();
    if (typeof api?.importTemplateFromData !== 'function') {
      throw new Error('数据库缺少 importTemplateFromData API');
    }
    const preparedSources = sources.map(source => ({
      ...source,
      template: getTemplateSnapshotFromDatabase(source),
    }));
    const merged = mergeTableTemplatesCore(preparedSources);
    const presetName = buildMergedTemplateLabel(preparedSources);
    const result = await runTableTemplateOperation(() => {
      if (onlyIfMissing && getNativeChatPresetBinding('tablePreset')) return { skipped: true };
      return api.importTemplateFromData(merged, {
      scope: 'chat',
      presetName,
      dataMode: 'seed',
      conflictPolicy: 'keep-current',
      });
    });
    if (result?.skipped) return result;
    const outcome = handleTemplatePresetApiResult('tablePreset', result, context);
    if (!outcome.saved) {
      throw new Error(outcome.error || `${context}失败`);
    }
    return { outcome, presetName, merged };
  }

  async function applyPresetBinding(feature) {
    const context = captureBindingContext();
    const api = getDatabaseApi();
    let presetOutcome = null;
    let managedPresetValue = '';
    const managed = getManagedPreset(feature);
    const nativeChat = getNativeChatPresetBinding(feature);
    const state = readState();
    const profile = getProfileState(state, false);
    const characterBindings = getCharacterBindings();
    const hasCharacter = Object.prototype.hasOwnProperty.call(characterBindings, feature);
    const inheritedScope = hasCharacter ? 'character' : 'global';
    const nativeGlobal = getNativeGlobalPresetBinding(feature);
    const inheritedValue = hasCharacter
      ? characterBindings[feature]
      : nativeGlobal?.value;
    if (nativeChat) {
      if (managed && !isManagedNativePresetBinding(nativeChat, managed)) {
        setManagedPreset(feature, null);
      }
      return restoreNativeChatPreset(feature, nativeChat);
    }
    if (inheritedValue === undefined) return false;
    // The database already handles global fallback. We only add missing character inheritance.
    if (feature === 'tablePreset' && !hasCharacter) return false;

    const tableCharacterBinding = feature === 'tablePreset' && hasCharacter
      ? normalizeCharacterTablePresetBindingCore(inheritedValue)
      : null;
    const embeddedPreset = tableCharacterBinding?.source === 'embedded'
      ? getEmbeddedTablePreset(tableCharacterBinding.embeddedPresetId)
      : null;
    if (tableCharacterBinding?.source === 'embedded' && !embeddedPreset) {
      throw new Error(`角色内嵌表格预设不存在: ${tableCharacterBinding.embeddedPresetId || '未指定 ID'}`);
    }
    const presetName = feature === 'tablePreset' && embeddedPreset
      ? embeddedPreset.name
      : feature === 'tablePreset'
      ? getTablePresetBindingNameCore(inheritedValue)
      : String(inheritedValue || '');
    managedPresetValue = presetName;
    if (
      feature === 'plotPreset'
      && !presetName
      && managed?.scope === inheritedScope
      && String(managed.value || '') === ''
    ) {
      return false;
    }

    if (feature === 'plotPreset') {
      if (typeof api?.switchPlotPreset !== 'function') throw new Error('数据库缺少 switchPlotPreset API');
      if (api.switchPlotPreset(presetName) === false) {
        throw new Error(`剧情推进预设继承失败: ${presetName || '数据库默认'}`);
      }
    } else if (tableCharacterBinding?.mergeGlobal) {
      if (!presetName) {
        throw new Error('合并全局模板需要角色绑定一个表格预设');
      }
      const globalName = String(runtime.settingsRef?.currentTemplatePresetName || '').trim();
      const mergedResult = await applyMergedTemplateSourcesToCurrentChat([
        {
          type: 'global',
          label: globalName ? `当前全局：${globalName}` : '当前全局：默认预设',
        },
        {
          ...(embeddedPreset
            ? { type: 'embedded', template: embeddedPreset.template }
            : { type: 'preset', name: presetName }),
          label: `角色：${presetName}`,
        },
      ], `表格预设继承并合并全局 ${presetName || '默认预设'}`, true);
      if (mergedResult.skipped) return false;
      presetOutcome = mergedResult.outcome;
      managedPresetValue = mergedResult.presetName;
    } else if (embeddedPreset) {
      if (typeof api?.importTemplateFromData !== 'function') {
        throw new Error('数据库缺少 importTemplateFromData API');
      }
      const result = await runTableTemplateOperation(() => {
        if (getNativeChatPresetBinding('tablePreset')) return { skipped: true };
        return api.importTemplateFromData(embeddedPreset.template, {
          scope: 'chat',
          presetName: `角色内嵌：${embeddedPreset.name}`,
          dataMode: 'seed',
          conflictPolicy: 'keep-current',
        });
      }, context);
      if (result?.skipped) return false;
      presetOutcome = handleTemplatePresetApiResult(
        feature,
        result,
        `角色内嵌表格预设继承 ${embeddedPreset.name}`,
      );
      managedPresetValue = `角色内嵌：${embeddedPreset.name}`;
    } else {
      if (typeof api?.switchTemplatePreset !== 'function') {
        throw new Error('数据库缺少 switchTemplatePreset API');
      }
      const result = await runTableTemplateOperation(() => {
        if (getNativeChatPresetBinding('tablePreset')) return { skipped: true };
        return switchTemplatePresetWithConfirmation(
          api, presetName, { scope: 'chat' }, `应用角色${FEATURE_LABELS[feature]}`,
        );
      }, context);
      if (result?.skipped) return false;
      presetOutcome = handleTemplatePresetApiResult(
        feature,
        result,
        `表格预设继承 ${presetName || '默认预设'}`,
      );
    }

    assertBindingContextCurrent(context);
    const appliedNative = getNativeChatPresetBinding(feature);
    if (appliedNative && (feature !== 'tablePreset' || presetOutcome?.fullyApplied)) {
      runtime.nativePresetAppliedTokens[feature] = buildNativePresetApplyToken(feature, appliedNative);
    }
    setManagedPreset(feature, {
      scope: inheritedScope,
      value: String(appliedNative?.value ?? managedPresetValue),
      bindingValue: clone(inheritedValue),
      inheritedAt: Date.now(),
      ...(Number(appliedNative?.nativeUpdatedAt) > 0
        ? { nativeUpdatedAt: Number(appliedNative.nativeUpdatedAt) }
        : {}),
      ...(appliedNative?.nativeFingerprint
        ? { nativeFingerprint: String(appliedNative.nativeFingerprint) }
        : {}),
    });
    return true;
  }

  async function runBindingsOnce(
    reason = 'manual',
    force = false,
    forceUiSync = false,
    worldbooksOnly = false,
    refreshWriteWorldbook = false,
    resetWriteWorldbook = false,
    context = captureBindingContext(),
  ) {
    runtime.applying = true;
    try {
      assertBindingContextCurrent(context);
      await waitForWorldbookApiIdle(context);
      const settings = await captureDatabaseSettings(true);
      assertBindingContextCurrent(context);
      if (!settings) throw new Error('尚未连接兼容的数据库运行时');
      await refreshActiveWorldbooks();
      assertBindingContextCurrent(context);
      ensureWorldbookChatBindings();

      const signature = buildApplySignature();
      if (!force && signature === runtime.lastApplySignature) return false;
      const worldbookResult = await applyWorldbookBindings(
        forceUiSync, context, resetWriteWorldbook || !!runtime.pendingWriteWorldbookTransition,
      );
      assertBindingContextCurrent(context);
      if (!worldbooksOnly) {
        await applyPresetBinding('plotPreset');
        assertBindingContextCurrent(context);
        await applyPresetBinding('tablePreset');
        assertBindingContextCurrent(context);
      }
      if (resetWriteWorldbook) {
        await resetWriteWorldbookViaDatabase(reason, { context });
      } else if (refreshWriteWorldbook && !worldbookResult.writeWorldbookRefreshed) {
        await waitForDatabaseTableReady(runtime.pendingWriteWorldbookTransition, context);
        await refreshWriteWorldbookViaDatabase(reason, context);
      }

      assertBindingContextCurrent(context);
      runtime.lastApplySignature = buildApplySignature();
      runtime.lastApplyReason = reason;
      runtime.lastApplyAt = Date.now();
      runtime.lastError = '';
      syncDatabaseUi();
      log(`已应用绑定 (${reason})。`);
      return true;
    } catch (error) {
      if (error?.code === 'SJBP_CONTEXT_CHANGED') return false;
      runtime.lastError = String(error?.message || error);
      warn(`应用绑定失败 (${reason}):`, error);
      return false;
    } finally {
      runtime.applying = false;
      refreshUiStatus();
    }
  }

  function applyBindings(
    reason = 'manual',
    force = false,
    forceUiSync = false,
    worldbooksOnly = false,
    refreshWriteWorldbook = false,
    resetWriteWorldbook = false,
  ) {
    if (!getIdentity().chatKey) {
      if (refreshWriteWorldbook || resetWriteWorldbook) {
        runtime.lastError = '请先打开一条对话，再清空或更新写入世界书';
        host.toastr?.info?.(runtime.lastError);
        return Promise.resolve(false);
      }
      const epoch = runtime.contextEpoch;
      return captureDatabaseSettings(true).then(settings => {
        if (runtime.contextEpoch !== epoch || getIdentity().chatKey) return false;
        if (!settings) {
          runtime.lastError ||= '数据库设置尚未就绪，请稍后重试';
          refreshUiStatus();
          return false;
        }
        runtime.lastError = '';
        refreshUiStatus();
        return true;
      });
    }
    const context = captureBindingContext();
    const queued = runtime.applyQueue
      .catch(() => false)
      .then(() => isBindingContextCurrent(context) ? runBindingsOnce(
        reason,
        force,
        forceUiSync,
        worldbooksOnly,
        refreshWriteWorldbook,
        resetWriteWorldbook,
        context,
      ) : false);
    runtime.applyQueue = queued.catch(error => {
      runtime.lastError = String(error?.message || error);
      warn(`绑定队列失败 (${reason}):`, error);
      return false;
    });
    return queued;
  }

  function requestWriteWorldbookReset(
    reason,
    { notifyIfBusy = false, allowCurrentDatabaseState = false } = {},
  ) {
    if (!getIdentity().chatKey) {
      runtime.lastError = '请先打开一条对话，再清空或更新写入世界书';
      host.toastr?.info?.(runtime.lastError);
      return Promise.resolve(false);
    }
    const context = captureBindingContext();
    if (!isBindingContextCurrent(context)) return Promise.resolve(false);
    if (allowCurrentDatabaseState && !runtime.writeWorldbookResetRequestPromise
      && runtime.pendingWriteWorldbookTransition) {
      runtime.pendingWriteWorldbookTransition.manualApproved = true;
      runtime.pendingWriteWorldbookTransition.manualApprovedAt = Date.now();
    }
    if (runtime.writeWorldbookResetRequestPromise
      && isBindingContextCurrent(runtime.writeWorldbookResetRequestPromise.context)) {
      if (notifyIfBusy) host.toastr?.info?.('写入世界书清空同步已在进行中');
      return runtime.writeWorldbookResetRequestPromise;
    }
    const request = applyBindings(reason, true, true, true, true, true)
      .finally(() => {
        if (runtime.writeWorldbookResetRequestPromise === request) {
          runtime.writeWorldbookResetRequestPromise = null;
        }
      });
    request.context = context;
    runtime.writeWorldbookResetRequestPromise = request;
    return request;
  }

  function scheduleApply(reason, delay = 700, force = true) {
    const context = captureBindingContext();
    clearTimeout(runtime.applyTimer);
    runtime.applyTimer = setTimeout(() => {
      if (!isBindingContextCurrent(context)) return;
      void applyBindings(reason, force);
    }, delay);
  }

  function schedulePostCaptureReapply(
    reason,
    delay = 5200,
    refreshWriteWorldbook = false,
    resetWriteWorldbook = false,
  ) {
    const context = captureBindingContext();
    if (!isBindingContextCurrent(context)) return;
    runtime.postCaptureRefreshWriteWorldbook = (
      runtime.postCaptureRefreshWriteWorldbook
      || refreshWriteWorldbook
    );
    runtime.postCaptureResetWriteWorldbook = (
      runtime.postCaptureResetWriteWorldbook
      || resetWriteWorldbook
    );
    runtime.postCaptureGeneration = runtime.settingsGeneration;
    clearTimeout(runtime.postCaptureReapplyTimer);
    runtime.postCaptureReapplyTimer = setTimeout(() => {
      if (!isBindingContextCurrent(context)) return;
      const scheduledGeneration = runtime.postCaptureGeneration;
      const shouldRefreshWriteWorldbook = runtime.postCaptureRefreshWriteWorldbook;
      const shouldResetWriteWorldbook = runtime.postCaptureResetWriteWorldbook;
      runtime.lastApplySignature = '';
      const operation = shouldResetWriteWorldbook
        ? requestWriteWorldbookReset(reason)
        : applyBindings(
          reason,
          true,
          true,
          true,
          shouldRefreshWriteWorldbook,
          false,
        );
      void operation.then(success => {
        if (!isBindingContextCurrent(context)) return;
        if (runtime.postCaptureGeneration !== scheduledGeneration) return;
        if (success) {
          runtime.postCaptureRefreshWriteWorldbook = false;
          runtime.postCaptureResetWriteWorldbook = false;
          runtime.postCaptureRetryAttempt = 0;
          return;
        }
        const retryDelays = [1200, 2500, 5000, 8000];
        const retryIndex = Math.min(runtime.postCaptureRetryAttempt, retryDelays.length - 1);
        runtime.postCaptureRetryAttempt += 1;
        schedulePostCaptureReapply(
          `${reason}重试 ${runtime.postCaptureRetryAttempt}`,
          retryDelays[retryIndex],
          shouldRefreshWriteWorldbook,
          shouldResetWriteWorldbook,
        );
      });
    }, delay);
  }

  function addTavernEventListener(eventName, handler) {
    if (typeof eventOn !== 'function' || !eventName) return;
    const registration = eventOn(eventName, handler);
    if (typeof registration?.stop === 'function') {
      runtime.eventDisposers.push(() => registration.stop());
    }
  }

  function installEventListeners() {
    if (runtime.eventDisposers.length) return;
    const events = typeof tavern_events !== 'undefined' ? tavern_events : {};
    const chatEvent = events.CHAT_CHANGED || 'chat_id_changed';
    const delayedEvents = [
      chatEvent,
      events.CHARACTER_EDITED || 'character_edited',
      events.PERSONA_CHANGED || 'persona_changed',
      events.PERSONA_UPDATED || 'persona_updated',
      events.WORLDINFO_SETTINGS_UPDATED || 'worldinfo_settings_updated',
      events.WORLDINFO_UPDATED || 'worldinfo_updated',
    ];
    for (const eventName of uniqueNames(delayedEvents)) {
      addTavernEventListener(eventName, () => {
        if (eventName === chatEvent) {
          invalidateBindingContext();
          runtime.settingsRef = null;
          runtime.settingsGeneration += 1;
          runtime.nativePresetAppliedTokens = {};
          resetPresetRuntimeState();
          runtime.lastApplySignature = '';
          if (!getIdentity().chatKey) return;
          beginWriteWorldbookTransition('对话切换');
          runtime.postCaptureRetryAttempt = 0;
          schedulePostCaptureReapply('对话切换后复核', 1800, true, true);
          scheduleApply(eventName, 300, true);
          // SillyTavern awaits listeners in order. Never block the database's
          // CHAT_CHANGED listener on the initialization that it must schedule.
          void requestWriteWorldbookReset('对话切换即时清空');
          return;
        }
        scheduleApply(eventName, 250, true);
        return undefined;
      });
    }
    const generationEvent = events.GENERATION_STARTED || 'generation_started';
    addTavernEventListener(generationEvent, () => {
      const resetPending = runtime.postCaptureResetWriteWorldbook;
      if (resetPending || runtime.pendingWriteWorldbookTransition) {
        return requestWriteWorldbookReset(`${generationEvent}（清空待处理）`);
      }
      return applyBindings(generationEvent, true);
    });
  }

  function getDatabaseUiWorldbookFeature(element) {
    if (!element?.closest) return '';
    if (element.closest(DB_UI_CONTRACT.tablePage)) return 'tableWorldbooks';
    if (element.closest(DB_UI_CONTRACT.plotPage)) return 'plotWorldbooks';
    return '';
  }

  function getRuntimeWorldbookBindingValue(feature, sourceOverride = '') {
    const identity = getIdentity();
    const config = feature === 'tableWorldbooks'
      ? getTableWorldbookConfig(runtime.settingsRef, identity.chatKey, true)
      : getPlotWorldbookConfig(runtime.settingsRef, true);
    const root = getVisibleDatabaseRoot();
    const page = feature === 'tableWorldbooks'
      ? root?.querySelector(DB_UI_CONTRACT.tablePage)
      : root?.querySelector(DB_UI_CONTRACT.plotPage);
    const uiConfig = readDatabaseUiWorldbookConfig(page);
    const effectiveConfig = uiConfig ? { ...config, ...uiConfig } : config;
    const chatValue = getBindingAtScope(feature, 'chat');
    const source = sourceOverride || (
      chatValue?.source === 'active'
        ? 'active'
        : (effectiveConfig?.source === 'manual' ? 'manual' : 'character')
    );
    return {
      source,
      manualSelection: source === 'manual' ? clone(effectiveConfig?.manualSelection || []) : [],
      enabledEntries: clone(config?.enabledEntries || {}),
    };
  }

  function queueDatabaseUiWorldbookSync(feature, sourceOverride = '', delay = 180) {
    clearTimeout(runtime.databaseUiSyncTimers[feature]);
    runtime.databaseUiSyncTimers[feature] = setTimeout(async () => {
      try {
        const value = getRuntimeWorldbookBindingValue(feature, sourceOverride);
        const config = feature === 'tableWorldbooks'
          ? getTableWorldbookConfig(runtime.settingsRef, getIdentity().chatKey, true)
          : getPlotWorldbookConfig(runtime.settingsRef, true);
        config.source = value.source === 'manual' ? 'manual' : 'character';
        config.manualSelection = clone(value.manualSelection);
        setBinding(feature, 'chat', value);
        runtime.lastApplySignature = '';
        await applyBindings(`数据库界面修改 ${FEATURE_LABELS[feature]}`, true, false, true);
      } catch (error) {
        runtime.lastError = `同步数据库界面失败: ${error?.message || error}`;
        warn(runtime.lastError);
      }
    }, delay);
  }

  function queueDatabaseUiWriteTargetSync(previousTarget) {
    const feature = 'writeWorldbook';
    clearTimeout(runtime.databaseUiSyncTimers[feature]);
    runtime.databaseUiSyncTimers[feature] = setTimeout(async () => {
      try {
        const config = getTableWorldbookConfig(runtime.settingsRef, getIdentity().chatKey, true);
        const page = getVisibleDatabaseRoot()?.querySelector(DB_UI_CONTRACT.tablePage);
        const nextTarget = normalizeInjectionTarget(
          readDatabaseUiInjectionTarget(page) || config?.injectionTarget,
        );
        if (nextTarget === normalizeInjectionTarget(previousTarget)) return;
        config.injectionTarget = nextTarget;
        setBinding(feature, 'chat', nextTarget);
        runtime.lastApplySignature = '';
        await applyBindings('数据库界面修改写入世界书', true, false, true);
      } catch (error) {
        runtime.lastError = `同步数据库写入目标失败: ${error?.message || error}`;
        warn(runtime.lastError);
      }
    }, 700);
  }

  function activateDatabaseUiAllWorldbooks(feature) {
    const config = feature === 'tableWorldbooks'
      ? getTableWorldbookConfig(runtime.settingsRef, getIdentity().chatKey, true)
      : getPlotWorldbookConfig(runtime.settingsRef, true);
    setBinding(feature, 'chat', {
      source: 'active',
      manualSelection: [],
      enabledEntries: clone(config?.enabledEntries || {}),
    });
    runtime.lastApplySignature = '';
    void applyBindings(
      `数据库界面选择酒馆当前全部 / ${FEATURE_LABELS[feature]}`,
      true,
      false,
      true,
    );
  }

  function syncDatabaseUiSourcePicker(page, feature) {
    const picker = page?.querySelector(DB_UI_CONTRACT.sourcePicker);
    const segmented = picker?.querySelector('.acu-segmented[aria-label="世界书来源"]');
    if (!picker || !segmented) return;

    let activeButton = segmented.querySelector('[data-sjbp-source-active]');
    if (!activeButton) {
      activeButton = host.document.createElement('button');
      activeButton.type = 'button';
      activeButton.className = 'acu-segmented__item sjbp-db-active-source';
      activeButton.dataset.sjbpSourceActive = feature;
      activeButton.setAttribute('role', 'radio');
      activeButton.innerHTML = '<span class="acu-segmented__label">酒馆当前全部</span>';
      activeButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        activateDatabaseUiAllWorldbooks(feature);
      });
      segmented.appendChild(activeButton);
    }

    const binding = resolveBinding(feature);
    const wantsActive = binding?.value?.source === 'active';
    const verification = runtime.settingsRef ? getVerificationReport().features?.[feature] : null;
    const isActive = wantsActive && verification?.matches === true;
    const nativeButtons = [...segmented.querySelectorAll(
      `${DB_UI_CONTRACT.segmentedItem}:not([data-sjbp-source-active])`,
    )];
    segmented.style.setProperty('--acu-segment-count', '3');
    activeButton.classList.toggle('acu-segmented__item--active', isActive);
    activeButton.setAttribute('aria-checked', isActive ? 'true' : 'false');
    picker.classList.toggle('sjbp-db-source-is-active', isActive);

    if (isActive) {
      for (const button of nativeButtons) {
        button.classList.remove('acu-segmented__item--active');
        button.setAttribute('aria-checked', 'false');
      }
      segmented.style.setProperty('--acu-segment-index', '2');
    }

    let status = picker.querySelector('.sjbp-db-active-status');
    if (wantsActive) {
      if (!status) {
        status = host.document.createElement('div');
        status.className = 'sjbp-db-active-status';
        segmented.insertAdjacentElement('afterend', status);
      }
      const origin = getChatBindingOrigin(feature);
      const originLabel = origin && origin !== 'chat' ? `，继承自${SCOPE_LABELS[origin]}` : '';
      const statusText = isActive
        ? `已生效：酒馆当前使用的全部世界书，共 ${runtime.activeWorldbooks.all.length} 本${originLabel}`
        : `尚未生效：正在把数据库同步到酒馆当前全部${originLabel}`;
      if (status.textContent !== statusText) status.textContent = statusText;
      status.classList.toggle('sjbp-db-active-status--error', !isActive);
      const hint = page.querySelector(DB_UI_CONTRACT.entryHintStrong);
      if (hint && isActive) {
        const names = runtime.activeWorldbooks.all.join('、') || '无';
        const hintText = `酒馆当前全部（${runtime.activeWorldbooks.all.length} 本）：${names}`;
        if (hint.textContent !== hintText) hint.textContent = hintText;
      }
    } else {
      status?.remove();
    }
  }

  function syncDatabaseUi() {
    if (runtime.databaseUiDriving) return;
    const root = host.document?.getElementById(DB_UI_CONTRACT.rootId);
    if (!root || root.style.display === 'none') return;
    syncDatabaseUiSourcePicker(root.querySelector(DB_UI_CONTRACT.tablePage), 'tableWorldbooks');
    syncDatabaseUiSourcePicker(root.querySelector(DB_UI_CONTRACT.plotPage), 'plotWorldbooks');
  }

  function installDatabaseUiIntegration() {
    const doc = host.document;
    if (!doc?.body || runtime.mutationObserver) return;
    const onClick = event => {
      const target = event.target;
      if (
        runtime.applying
        || runtime.databaseUiDriving
        || !target?.closest
        || target.closest('[data-sjbp-source-active]')
      ) return;

      const sourceButton = target.closest(
        `${DB_UI_CONTRACT.sourcePicker} ${DB_UI_CONTRACT.segmentedItem}`,
      );
      if (sourceButton) {
        const feature = getDatabaseUiWorldbookFeature(sourceButton);
        const label = String(sourceButton.textContent || '').trim();
        const source = label.includes('手动') ? 'manual' : 'character';
        if (feature) queueDatabaseUiWorldbookSync(feature, source, 100);
        return;
      }

      const picker = target.closest(DB_UI_CONTRACT.entryPicker);
      if (picker) {
        const feature = getDatabaseUiWorldbookFeature(picker);
        if (feature) queueDatabaseUiWorldbookSync(feature, '', 220);
        return;
      }

      const targetOption = target.closest(DB_UI_CONTRACT.injectionOption);
      if (targetOption) {
        const config = getTableWorldbookConfig(runtime.settingsRef, getIdentity().chatKey, true);
        queueDatabaseUiWriteTargetSync(config?.injectionTarget);
      }
    };
    doc.addEventListener('click', onClick);
    runtime.eventDisposers.push(() => doc.removeEventListener('click', onClick));

    const onDatabaseOpenClick = event => {
      const control = event.target?.closest?.(DB_UI_CONTRACT.menuControls);
      const label = String(
        control?.getAttribute?.('aria-label')
        || control?.getAttribute?.('title')
        || control?.textContent
        || '',
      ).trim();
      if (
        control?.id === DB_UI_CONTRACT.menuItemId
        || control?.id === DB_UI_CONTRACT.openEditorId
        || label === DB_UI_CONTRACT.labels.open
      ) {
        scheduleDatabaseUiOpenReapply();
      }
    };
    doc.addEventListener('click', onDatabaseOpenClick, true);
    runtime.eventDisposers.push(() => doc.removeEventListener('click', onDatabaseOpenClick, true));

    function clearDatabaseUiOpenTimers() {
      for (const timer of runtime.databaseUiOpenTimers.splice(0)) clearTimeout(timer);
    }

    function scheduleDatabaseUiOpenReapply() {
      clearDatabaseUiOpenTimers();
      const delays = [700];
      delays.forEach((delay, index) => {
        const timer = setTimeout(() => {
          const root = doc.getElementById(DB_UI_CONTRACT.rootId);
          const stillVisible = !!root
            && host.getComputedStyle(root).display !== 'none'
            && !root.classList.contains('sjbp-headless');
          if (!stillVisible || runtime.databaseUiDriving) return;
          runtime.lastApplySignature = '';
          void applyBindings(
            `打开数据库界面只读复核 ${index + 1}/${delays.length}`,
            true,
            false,
            true,
          );
        }, delay);
        runtime.databaseUiOpenTimers.push(timer);
      });
    }

    function trackDatabaseUiVisibility() {
      const root = doc.getElementById(DB_UI_CONTRACT.rootId);
      const visible = !!root
        && host.getComputedStyle(root).display !== 'none'
        && !root.classList.contains('sjbp-headless');
      if (runtime.databaseUiDriving) {
        if (!visible) runtime.databaseUiVisible = false;
        return;
      }
      if (
        visible
        && !runtime.databaseUiVisible
      ) {
        scheduleDatabaseUiOpenReapply();
      } else if (!visible && runtime.databaseUiVisible) {
        clearDatabaseUiOpenTimers();
      }
      runtime.databaseUiVisible = visible;
    }

    runtime.trackDatabaseUiVisibility = trackDatabaseUiVisibility;
    runtime.mutationObserver = new MutationObserver(() => {
      trackDatabaseUiVisibility();
      clearTimeout(runtime.databaseUiTimer);
      runtime.databaseUiTimer = setTimeout(syncDatabaseUi, 20);
    });
    runtime.mutationObserver.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    trackDatabaseUiVisibility();
    syncDatabaseUi();
  }

  function disableLegacyPatch() {
    try {
      const legacy = host.ShujukuWorldbookGlobalPatch;
      if (typeof legacy?.setEnabled === 'function') legacy.setEnabled(false);
      const oldRuntime = host.__SHUJUKU_WORLDBOOK_GLOBAL_PATCH_V1__;
      if (oldRuntime?.intervalId) clearInterval(oldRuntime.intervalId);
    } catch (error) {
      warn('停用旧世界书全局补丁失败:', error);
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);
  }

  function formatNames(names) {
    return names?.length ? names.map(escapeHtml).join('、') : '<span class="sjbp-muted">无</span>';
  }

  function describeBinding(feature, binding) {
    if (!binding) return '未接管';
    const value = binding.value;
    if (feature === 'writeWorldbook') return value === 'character' ? '角色主世界书' : String(value || '未设置');
    if (feature === 'tableWorldbooks' || feature === 'plotWorldbooks') {
      if (value?.source === 'active') return `酒馆当前全部 (${runtime.activeWorldbooks.all.length})`;
      if (value?.source === 'manual') {
        const books = uniqueNames(value.manualSelection);
        const entryCount = books.reduce((total, name) => (
          total + (Array.isArray(value.enabledEntries?.[name]) ? value.enabledEntries[name].length : 0)
        ), 0);
        return `手动选择 (${books.length} 本，${entryCount} 条)`;
      }
      return '跟随角色卡';
    }
    if (feature === 'tablePreset' && isObject(value)) {
      const normalized = normalizeCharacterTablePresetBindingCore(value);
      const embedded = normalized.source === 'embedded'
        ? getEmbeddedTablePreset(normalized.embeddedPresetId)
        : null;
      const presetLabel = normalized.source === 'embedded'
        ? `内嵌 · ${embedded?.name || normalized.embeddedPresetId || '缺失预设'}`
        : (normalized.presetName || '默认预设');
      return normalized.mergeGlobal ? `${presetLabel}（合并全局）` : presetLabel;
    }
    if (!value) return feature === 'plotPreset' ? '跟随数据库全局' : '默认预设';
    return String(value);
  }

  function describeFeatureValue(feature, value) {
    return describeBinding(feature, { value });
  }

  function getCurrentTablePresetName() {
    const chatName = getNativeTablePresetState()?.presetName;
    return typeof chatName === 'string' ? chatName : String(runtime.settingsRef?.currentTemplatePresetName || '');
  }

  function getControlDraftKey(feature, scope) {
    const identity = getIdentity();
    const owner = scope === 'global'
      ? 'global'
      : (scope === 'character' ? identity.characterKey : identity.chatKey);
    return [getIsolationKey(), scope, owner || 'none', feature].join('::');
  }

  function getControlDraft(feature, scope) {
    const key = getControlDraftKey(feature, scope);
    return Object.prototype.hasOwnProperty.call(runtime.controlDrafts, key)
      ? clone(runtime.controlDrafts[key])
      : undefined;
  }

  function setControlDraft(feature, scope, value) {
    runtime.controlDrafts[getControlDraftKey(feature, scope)] = clone(value);
  }

  function clearControlDraft(feature, scope) {
    delete runtime.controlDrafts[getControlDraftKey(feature, scope)];
  }

  function getDatabaseControlValue(feature) {
    const identity = getIdentity();
    const tableConfig = getTableWorldbookConfig(runtime.settingsRef, identity.chatKey, false) || {};
    if (feature === 'writeWorldbook') return String(tableConfig.injectionTarget || 'character');
    if (feature === 'tableWorldbooks') {
      return {
        source: tableConfig.source === 'manual' ? 'manual' : 'character',
        manualSelection: clone(tableConfig.manualSelection || []),
        enabledEntries: clone(tableConfig.enabledEntries || {}),
      };
    }
    if (feature === 'plotWorldbooks') {
      const config = getPlotWorldbookConfig(runtime.settingsRef, false) || {};
      return {
        source: config.source === 'manual' ? 'manual' : 'character',
        manualSelection: clone(config.manualSelection || []),
        enabledEntries: clone(config.enabledEntries || {}),
      };
    }
    if (feature === 'plotPreset') {
      return String(getDatabaseApi()?.getCurrentPlotPreset?.() || '');
    }
    return getCurrentTablePresetName();
  }

  function getControlValue(feature, scope) {
    const draft = getControlDraft(feature, scope);
    if (draft !== undefined) return draft;
    const scoped = getBindingAtScope(feature, scope);
    if (scoped !== undefined) return scoped;
    return resolveControlFallbackCore(
      feature,
      scope,
      getDatabaseControlValue(feature),
      getNativeChatPresetBinding(feature),
      getManagedPreset(feature),
    );
  }

  function buildSelectControl(feature, options, selected, searchable = false) {
    const selectedValue = String(selected ?? '');
    const selectedOption = options.find(item => String(item.value) === selectedValue) || options[0];
    const visibleLabel = selectedOption?.label ?? selectedValue;
    return `<div class="sjbp-combobox" data-combobox="${feature}">
      <input type="hidden" data-control="${feature}" value="${escapeHtml(selectedValue)}">
      <button type="button" class="sjbp-select" data-select-trigger="${feature}" aria-haspopup="listbox" aria-expanded="false">
        <span data-select-label>${escapeHtml(visibleLabel)}</span>
        <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
      </button>
      <div class="sjbp-select-menu${searchable ? ' has-filter' : ''}" data-select-menu="${feature}" role="presentation" hidden>
        ${searchable ? `<label class="sjbp-menu-filter">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input type="search" data-menu-filter="${feature}" placeholder="筛选选项" aria-label="筛选${escapeHtml(FEATURE_LABELS[feature])}选项" autocomplete="off" spellcheck="false">
        </label>` : ''}
        <div class="sjbp-select-options" role="listbox" aria-label="${escapeHtml(FEATURE_LABELS[feature])}选项">
          ${options.map(item => {
            const value = String(item.value ?? '');
            const selectedOptionValue = value === selectedValue;
            return `<button type="button" role="option" class="sjbp-select-option${selectedOptionValue ? ' is-selected' : ''}" data-select-option="${feature}" data-value="${escapeHtml(value)}" data-label="${escapeHtml(item.label)}" aria-selected="${selectedOptionValue}">
              <span>${escapeHtml(item.label)}</span>
              <i class="fa-solid fa-check" aria-hidden="true"></i>
            </button>`;
          }).join('')}
        </div>
      </div>
    </div>`;
  }

  async function openNativeTableTemplate() {
    const api = getDatabaseApi();
    if (typeof api?.openSettings !== 'function') {
      runtime.lastError = '数据库设置入口尚不可用';
      renderDialog();
      return false;
    }
    try {
      const result = await api.openSettings();
      if (result === false) throw new Error('数据库设置界面未能打开');
      const root = host.document.getElementById(DB_UI_CONTRACT.rootId);
      const tableTab = [...(root?.querySelectorAll(DB_UI_CONTRACT.sidebarItem) || [])]
        .find(item => item.textContent.trim() === DB_UI_CONTRACT.labels.formFill);
      tableTab?.click();
      closeDialog();
      if (root) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
          const panel = root.querySelector(DB_UI_CONTRACT.templatePanel);
          if (panel) {
            panel.scrollIntoView({ block: 'start' });
            break;
          }
        }
      }
      return true;
    } catch (error) {
      runtime.lastError = String(error?.message || error);
      renderDialog();
      return false;
    }
  }

  function buildFeatureControl(feature, scope) {
    if (feature === 'tablePreset' && scope === 'chat') {
      return '<button type="button" class="sjbp-command-button" data-open-native-template><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span>在数据库中管理对话模板</span></button>';
    }
    const current = getControlValue(feature, scope);
    if (feature === 'writeWorldbook') {
      const names = runtime.activeWorldbooks.available;
      return buildSelectControl(feature, [
        { value: 'character', label: '角色主世界书' },
        ...names.map(name => ({ value: name, label: name })),
      ], current, true);
    }
    if (feature === 'tableWorldbooks' || feature === 'plotWorldbooks') {
      const source = current?.source || 'character';
      return `<div class="sjbp-worldbook-control">
        ${buildSelectControl(feature, [
          { value: 'character', label: '跟随角色卡' },
          { value: 'manual', label: '手动选择' },
          { value: 'active', label: '酒馆当前使用的全部世界书' },
        ], source)}
        <button type="button" class="sjbp-icon-button" data-edit-manual="${feature}" title="选择世界书和条目" aria-label="选择世界书和条目"${source === 'manual' ? '' : ' disabled'}>
          <i class="fa-solid fa-list-check"></i>
        </button>
      </div>`;
    }
    if (feature === 'plotPreset') {
      const presets = getDatabaseApi()?.getPlotPresets?.() || [];
      const names = uniqueNames([
        ...presets.map(item => typeof item === 'string' ? item : item?.name),
        current,
      ]);
      return buildSelectControl(feature, [
        { value: '', label: '跟随数据库全局' },
        ...names.map(name => ({ value: name, label: name })),
      ], current, true);
    }
    const normalized = scope === 'character'
      ? normalizeCharacterTablePresetBindingCore(current)
      : null;
    const selectedPresetName = normalized
      ? normalized.presetName
      : getTablePresetBindingNameCore(current);
    const knownNames = uniqueNames(getDatabaseApi()?.getTemplatePresetNames?.() || []);
    const names = uniqueNames([...knownNames, selectedPresetName]);
    const options = [
      { value: '', label: '默认预设' },
      ...names.map(name => ({
        value: name,
        label: knownNames.includes(name)
          ? (scope === 'character' ? `全局 · ${name}` : name)
          : `${name}（当前对话快照）`,
      })),
    ];
    if (scope === 'character') {
      for (const preset of Object.values(getEmbeddedTablePresets())) {
        options.push({ value: `embedded:${preset.id}`, label: `内嵌 · ${preset.name}` });
      }
    }
    return buildSelectControl(
      feature,
      options,
      normalized ? serializeTablePresetSelectionCore(normalized) : selectedPresetName,
      true,
    );
  }

  function buildScopeControl(feature, selectedScope) {
    return `<div class="sjbp-scopes" role="group" aria-label="${escapeHtml(FEATURE_LABELS[feature])}绑定范围">
      ${SCOPE_IDS.map(scope => `<button type="button" data-scope-feature="${feature}" data-scope="${scope}" class="${scope === selectedScope ? 'is-active' : ''}">${SCOPE_LABELS[scope]}</button>`).join('')}
    </div>`;
  }

  function buildFeatureRow(feature, state) {
    const scope = getEditScope(feature, state);
    const effective = resolveBinding(feature);
    const scopeBinding = getBindingAtScope(feature, scope);
    const draft = getControlDraft(feature, scope);
    const inheritedScope = effective?.scope === 'chat'
      ? (NATIVE_PRESET_FEATURES.has(feature) ? getManagedPreset(feature)?.scope : getChatBindingOrigin(feature))
      : '';
    let effectiveReason;
    if (!effective) {
      effectiveReason = `未设置补丁绑定，沿用数据库当前配置：${describeFeatureValue(feature, getDatabaseControlValue(feature))}`;
    } else if (effective.native && inheritedScope && inheritedScope !== 'chat') {
      effectiveReason = `数据库原生对话快照，由${SCOPE_LABELS[inheritedScope]}绑定初始化`;
    } else if (effective.native) {
      effectiveReason = feature === 'tablePreset' && effective.scope === 'chat'
        ? '数据库管理的独立对话模板'
        : `数据库原生${SCOPE_LABELS[effective.scope]}绑定`;
    } else if (effective.scope === 'chat' && inheritedScope && inheritedScope !== 'chat') {
      effectiveReason = `对话快照，首次由${SCOPE_LABELS[inheritedScope]}绑定固化`;
    } else if (effective.scope === 'character') {
      effectiveReason = '当前对话没有绑定，采用角色绑定';
    } else if (effective.scope === 'global') {
      effectiveReason = '当前对话和角色均没有绑定，采用全局绑定';
    } else {
      effectiveReason = '当前对话绑定';
    }
    if (!getIdentity().chatKey) effectiveReason = '已保存的默认绑定；打开对话后按优先级应用';
    let selectedScopeStatus;
    if (scopeBinding !== undefined) {
      selectedScopeStatus = `已绑定：${describeFeatureValue(feature, scopeBinding)}`;
      if (
        draft !== undefined
        && !controlValuesEquivalentCore(feature, draft, scopeBinding, runtime.activeWorldbooks.all)
      ) {
        selectedScopeStatus += `；待绑定：${describeFeatureValue(feature, draft)}`;
      }
    } else if (draft !== undefined) {
      selectedScopeStatus = `未绑定；待保存：${describeFeatureValue(feature, draft)}（点击链接按钮后生效）`;
    } else {
      selectedScopeStatus = `未绑定；选择器初值：${describeFeatureValue(feature, getControlValue(feature, scope))}`;
    }
    if (feature === 'tablePreset' && scope === 'chat') {
      selectedScopeStatus = scopeBinding === undefined ? '沿用数据库全局模板' : `数据库对话模板：${scopeBinding || '对话自定义模板'}`;
    }
    const characterTableBinding = feature === 'tablePreset' && scope === 'character'
      ? normalizeCharacterTablePresetBindingCore(getControlValue(feature, scope))
      : null;
    const characterTableHasSelection = !!(
      characterTableBinding?.presetName || characterTableBinding?.embeddedPresetId
    );
    return `<section class="sjbp-row" data-feature-row="${feature}">
      <div class="sjbp-row-title">
        <strong>${FEATURE_LABELS[feature]}</strong>
      </div>
      <div class="sjbp-binding-status">
        <div><b>当前生效</b><span>${effective ? `${escapeHtml(describeBinding(feature, effective))}；${escapeHtml(effectiveReason)}` : escapeHtml(effectiveReason)}</span></div>
        <div><b>当前范围</b><span>${SCOPE_LABELS[scope]} · ${escapeHtml(selectedScopeStatus)}</span></div>
      </div>
      <div class="sjbp-row-controls${feature === 'tablePreset' && scope === 'chat' ? ' sjbp-native-template-controls' : ''}">
        ${buildFeatureControl(feature, scope)}
        ${buildScopeControl(feature, scope)}
        ${feature === 'tablePreset' && scope === 'chat' ? '' : `<button type="button" class="sjbp-icon-button" data-bind="${feature}" data-bind-scope="${scope}" title="绑定当前选择" aria-label="绑定当前选择"><i class="fa-solid fa-link"></i></button>
        <button type="button" class="sjbp-icon-button" data-clear="${feature}" data-clear-scope="${scope}" title="${scopeBinding === undefined && draft !== undefined ? '取消待保存选择' : '清除此范围的绑定'}" aria-label="${scopeBinding === undefined && draft !== undefined ? '取消待保存选择' : '清除此范围的绑定'}"${scopeBinding === undefined && draft === undefined ? ' disabled' : ''}><i class="fa-solid fa-link-slash"></i></button>`}
      </div>
      ${feature === 'tablePreset' ? `<div class="sjbp-table-preset-actions">
        ${scope === 'character' ? `<label class="sjbp-toggle-row${characterTableHasSelection ? '' : ' is-disabled'}">
          <input type="checkbox" data-table-merge-global${characterTableBinding?.mergeGlobal ? ' checked' : ''}${characterTableHasSelection ? '' : ' disabled'}>
          <span>合并当前全局模板；同名表格以角色预设为准</span>
        </label>
        <div class="sjbp-embedded-preset-actions">
          <button type="button" class="sjbp-command-button" data-copy-embedded-table>
            <i class="fa-solid fa-copy" aria-hidden="true"></i><span>复制为内嵌</span>
          </button>
          <button type="button" class="sjbp-command-button" data-copy-embedded-to-global${characterTableBinding?.source === 'embedded' ? '' : ' disabled'}>
            <i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i><span>复制到全局</span>
          </button>
          <button type="button" class="sjbp-command-button" data-delete-embedded-table${characterTableBinding?.source === 'embedded' ? '' : ' disabled'}>
            <i class="fa-solid fa-trash" aria-hidden="true"></i><span>删除内嵌</span>
          </button>
        </div>` : ''}
        <button type="button" class="sjbp-command-button" data-open-template-merge>
          <i class="fa-solid fa-layer-group" aria-hidden="true"></i>
          <span>重新应用到当前对话</span>
        </button>
      </div>` : ''}
    </section>`;
  }

  function buildActiveWorldbookSummary() {
    const active = runtime.activeWorldbooks;
    const characterNames = uniqueNames([active.characterPrimary, ...active.characterAdditional]);
    return `<section class="sjbp-active">
      <div><strong>酒馆当前全部</strong><span>${active.all.length} 本</span></div>
      <dl>
        <dt>全局</dt><dd>${formatNames(active.global)}</dd>
        <dt>角色</dt><dd>${formatNames(characterNames)}</dd>
        <dt>对话</dt><dd>${formatNames(active.chat)}</dd>
        <dt>用户设定（人设）</dt><dd>${formatNames(active.persona ? [active.persona] : [])}</dd>
      </dl>
    </section>`;
  }

  async function readWorldbookEntriesForEditor(bookName) {
    if (typeof getWorldbookNames !== 'function' || typeof getWorldbook !== 'function') {
      throw new Error('酒馆助手世界书 API 不可用');
    }
    const available = getWorldbookNames();
    if (!available.includes(bookName)) {
      throw new Error(`酒馆助手未能找到世界书 '${bookName}'`);
    }
    const entries = await getWorldbook(bookName);
    if (!Array.isArray(entries)) {
      throw new Error(`酒馆助手返回了无效的世界书条目: ${bookName}`);
    }
    return normalizeWorldbookEntriesCore(entries);
  }

  async function readAgentWorldbookSnapshotForEditor() {
    const fallback = runtime.settingsRef?.plotSettings?.agentWorldbookControlSnapshot;
    try {
      const result = await getDatabaseApi()?.getAgentWorldbookControl?.();
      if (result?.success && result.snapshot) return result.snapshot;
    } catch (_) {
      // The legacy settings snapshot below still covers older database builds.
    }
    return fallback || null;
  }

  function rebuildManualEditorGroups() {
    const editor = runtime.manualEditor;
    if (!editor) return;
    const built = buildWorldbookEntryGroupsCore(
      editor.bookNames,
      editor.entriesByBook,
      editor.enabledEntries,
      editor.snapshot,
      editor.expandedBooks,
    );
    editor.groups = built.groups;
    editor.enabledEntries = built.enabledEntries;
  }

  async function loadManualEditorEntries(bookNames) {
    const editor = runtime.manualEditor;
    if (!editor) return;
    const pending = uniqueNames(bookNames).filter(name => !Object.prototype.hasOwnProperty.call(editor.entriesByBook, name));
    if (!pending.length) {
      editor.loading = false;
      rebuildManualEditorGroups();
      renderDialog();
      return;
    }
    editor.loading = true;
    editor.error = '';
    renderDialog();
    const failures = [];
    await Promise.all(pending.map(async name => {
      try {
        editor.entriesByBook[name] = await readWorldbookEntriesForEditor(name);
      } catch (error) {
        editor.entriesByBook[name] = [];
        failures.push(`${name}：${String(error?.message || error)}`);
      }
    }));
    if (runtime.manualEditor !== editor) return;
    editor.loading = false;
    editor.error = failures.join('；');
    rebuildManualEditorGroups();
    renderDialog();
  }

  async function openManualEditor(feature) {
    assertBindingScopeAvailable(getEditScope(feature));
    const state = readState();
    const scope = getEditScope(feature, state);
    const current = getControlValue(feature, scope);
    const fallbackConfig = getDatabaseControlValue(feature);
    const bookNames = uniqueNames(
      current?.source === 'manual'
        ? current.manualSelection
        : fallbackConfig?.manualSelection,
    );
    runtime.manualEditor = {
      feature,
      scope,
      bookNames,
      enabledEntries: clone(current?.enabledEntries || fallbackConfig?.enabledEntries || {}),
      entriesByBook: {},
      groups: [],
      expandedBooks: [],
      snapshot: null,
      loading: true,
      error: '',
      bookFilter: '',
      entryFilter: '',
    };
    renderDialog();
    const editor = runtime.manualEditor;
    editor.snapshot = await readAgentWorldbookSnapshotForEditor();
    if (runtime.manualEditor !== editor) return;
    await loadManualEditorEntries(bookNames);
  }

  function buildManualWorldbookList(editor) {
    const selected = new Set(editor.bookNames);
    return runtime.activeWorldbooks.available.map(name => `
      <label class="sjbp-check-row" data-book-row data-search-text="${escapeHtml(name.toLocaleLowerCase())}">
        <input type="checkbox" data-manual-book="${escapeHtml(name)}"${selected.has(name) ? ' checked' : ''}>
        <span>${escapeHtml(name)}</span>
      </label>
    `).join('');
  }

  function buildManualEntryGroups(editor) {
    if (editor.loading && !editor.groups.length) {
      return '<div class="sjbp-manual-empty"><i class="fa-solid fa-spinner fa-spin"></i><span>正在读取世界书条目</span></div>';
    }
    if (!editor.bookNames.length) {
      return '<div class="sjbp-manual-empty">先选择至少一本世界书</div>';
    }
    if (!editor.groups.length) {
      return '<div class="sjbp-manual-empty">所选世界书没有可供数据库读取的条目</div>';
    }
    return editor.groups.map(group => `
      <section class="sjbp-entry-group" data-entry-group>
        <button type="button" class="sjbp-entry-group-title" data-toggle-entry-group="${escapeHtml(group.bookName)}" aria-expanded="${group.expanded}">
          <i class="fa-solid fa-chevron-${group.expanded ? 'down' : 'right'}" aria-hidden="true"></i>
          <span>${escapeHtml(group.bookName)}</span>
          <small>${group.entries.filter(entry => entry.checked).length}/${group.entries.length}</small>
        </button>
        <div class="sjbp-entry-list"${group.expanded ? '' : ' hidden'}>
          ${group.entries.map(entry => `
            <label class="sjbp-check-row${entry.disabled ? ' is-disabled' : ''}" data-entry-row data-search-text="${escapeHtml(`${entry.label} ${group.bookName}`.toLocaleLowerCase())}">
              <input type="checkbox" data-manual-entry="${escapeHtml(String(entry.uid))}" data-book="${escapeHtml(group.bookName)}"${entry.checked ? ' checked' : ''}${entry.disabled ? ' disabled' : ''}>
              <span>${escapeHtml(entry.label)}</span>
              ${entry.isConstant ? '<small>常量</small>' : ''}
            </label>
          `).join('')}
        </div>
      </section>
    `).join('');
  }

  function buildManualEditorHtml() {
    const editor = runtime.manualEditor;
    const selectedEntryCount = editor.bookNames.reduce((total, name) => (
      total + (Array.isArray(editor.enabledEntries[name]) ? editor.enabledEntries[name].length : 0)
    ), 0);
    return `<div class="sjbp-dialog sjbp-manual-dialog" role="dialog" aria-modal="true" aria-labelledby="sjbp-manual-title">
      <header>
        <div>
          <h2 id="sjbp-manual-title">${escapeHtml(FEATURE_LABELS[editor.feature])} · 手动选择</h2>
          <p>${SCOPE_LABELS[editor.scope]}范围 · ${editor.bookNames.length} 本世界书 · ${selectedEntryCount} 个条目</p>
        </div>
        <button type="button" class="sjbp-icon-button" data-manual-cancel title="返回" aria-label="返回"><i class="fa-solid fa-arrow-left"></i></button>
      </header>
      <main class="sjbp-manual-body">
        <section class="sjbp-manual-column">
          <div class="sjbp-manual-heading"><strong>世界书</strong><span>${editor.bookNames.length}/${runtime.activeWorldbooks.available.length}</span></div>
          <label class="sjbp-menu-filter sjbp-static-filter">
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input type="search" data-manual-book-filter value="${escapeHtml(editor.bookFilter)}" placeholder="筛选世界书" aria-label="筛选世界书" autocomplete="off" spellcheck="false">
          </label>
          <div class="sjbp-check-list" data-manual-book-list>
            ${buildManualWorldbookList(editor)}
          </div>
        </section>
        <section class="sjbp-manual-column sjbp-manual-entries">
          <div class="sjbp-manual-heading">
            <strong>读取条目</strong>
            <div class="sjbp-entry-actions">
              <button type="button" class="sjbp-icon-button" data-entry-select-all title="全选可用条目" aria-label="全选可用条目"><i class="fa-solid fa-check-double"></i></button>
              <button type="button" class="sjbp-icon-button" data-entry-select-none title="全不选" aria-label="全不选"><i class="fa-solid fa-square-xmark"></i></button>
            </div>
          </div>
          <label class="sjbp-menu-filter sjbp-static-filter">
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input type="search" data-manual-entry-filter value="${escapeHtml(editor.entryFilter)}" placeholder="筛选条目" aria-label="筛选条目" autocomplete="off" spellcheck="false">
          </label>
          ${editor.error ? `<div class="sjbp-manual-error">${escapeHtml(editor.error)}</div>` : ''}
          <div class="sjbp-entry-groups" data-manual-entry-groups>
            ${buildManualEntryGroups(editor)}
          </div>
        </section>
      </main>
      <footer>
        <span>完成后仍需点击主面板的链接按钮，才会写入所选范围。</span>
        <div class="sjbp-footer-actions">
          <button type="button" class="sjbp-command-button" data-manual-cancel>取消</button>
          <button type="button" class="sjbp-command-button is-primary" data-manual-save>完成选择</button>
        </div>
      </footer>
    </div>`;
  }

  function getTemplateMergeSourceCatalog() {
    const sources = [{ key: 'global', type: 'global', label: '当前全局模板' }];
    if (getNativeTablePresetState()) {
      sources.push({ key: 'chat', type: 'chat', label: '当前聊天模板' });
    }
    const names = uniqueNames(getDatabaseApi()?.getTemplatePresetNames?.() || []);
    for (const name of names) {
      sources.push({
        key: `preset:${name}`,
        type: 'preset',
        name,
        label: `全局预设 · ${name}`,
      });
    }
    for (const preset of Object.values(getEmbeddedTablePresets())) {
      sources.push({
        key: `embedded:${preset.id}`,
        type: 'embedded',
        name: preset.name,
        label: `角色内嵌 · ${preset.name}`,
        template: clone(preset.template),
      });
    }
    return sources;
  }

  function getInitialTemplateMergeSelection(catalog) {
    const byKey = new Map(catalog.map(source => [source.key, source]));
    const roleBinding = normalizeCharacterTablePresetBindingCore(
      getBindingAtScope('tablePreset', 'character'),
    );
    const selected = [];
    if (roleBinding.mergeGlobal && byKey.has('global')) selected.push(clone(byKey.get('global')));
    const roleKey = roleBinding.source === 'embedded'
      ? `embedded:${roleBinding.embeddedPresetId}`
      : (roleBinding.presetName ? `preset:${roleBinding.presetName}` : '');
    if (roleKey && byKey.has(roleKey)) selected.push(clone(byKey.get(roleKey)));
    if (!selected.length && byKey.has('chat')) selected.push(clone(byKey.get('chat')));
    if (!selected.length && byKey.has('global')) selected.push(clone(byKey.get('global')));
    return selected;
  }

  function openTemplateMergeEditor() {
    assertBindingScopeAvailable('chat');
    const catalog = getTemplateMergeSourceCatalog();
    runtime.templateMergeEditor = {
      catalog,
      selected: getInitialTemplateMergeSelection(catalog),
      filter: '',
      applying: false,
      error: '',
    };
    renderDialog();
  }

  function buildTemplateMergeEditorHtml() {
    const editor = runtime.templateMergeEditor;
    const selectedKeys = new Set(editor.selected.map(source => source.key));
    return `<div class="sjbp-dialog sjbp-template-merge-dialog" role="dialog" aria-modal="true" aria-labelledby="sjbp-template-merge-title">
      <header>
        <div>
          <h2 id="sjbp-template-merge-title">重新应用表格模板</h2>
          <p>选择多个模板并调整顺序；越靠下优先级越高，同名表格会完整覆盖。</p>
        </div>
        <button type="button" class="sjbp-icon-button" data-template-merge-cancel title="返回" aria-label="返回"><i class="fa-solid fa-arrow-left"></i></button>
      </header>
      <main class="sjbp-template-merge-body">
        <section class="sjbp-template-source-panel">
          <div class="sjbp-manual-heading"><strong>可用模板</strong><span>${editor.catalog.length}</span></div>
          <label class="sjbp-menu-filter sjbp-static-filter">
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input type="search" data-template-source-filter value="${escapeHtml(editor.filter)}" placeholder="筛选模板" aria-label="筛选模板" autocomplete="off" spellcheck="false">
          </label>
          <div class="sjbp-check-list" data-template-source-list>
            ${editor.catalog.map(source => `<label class="sjbp-check-row" data-template-source-row data-search-text="${escapeHtml(source.label.toLocaleLowerCase())}">
              <input type="checkbox" data-template-source="${escapeHtml(source.key)}"${selectedKeys.has(source.key) ? ' checked' : ''}${editor.applying ? ' disabled' : ''}>
              <span>${escapeHtml(source.label)}</span>
              ${source.type === 'global' ? '<small>全局</small>' : (source.type === 'chat' ? '<small>聊天</small>' : '<small>预设</small>')}
            </label>`).join('')}
          </div>
        </section>
        <section class="sjbp-template-order-panel">
          <div class="sjbp-manual-heading"><strong>合并顺序</strong><span>${editor.selected.length} 项</span></div>
          <div class="sjbp-template-order-list">
            ${editor.selected.length ? editor.selected.map((source, index) => `<div class="sjbp-template-order-row">
              <span class="sjbp-template-priority">${index + 1}</span>
              <span>${escapeHtml(source.label)}</span>
              <div class="sjbp-template-order-actions">
                <button type="button" class="sjbp-icon-button" data-template-move="${index}" data-direction="-1" title="上移" aria-label="上移"${index === 0 || editor.applying ? ' disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="sjbp-icon-button" data-template-move="${index}" data-direction="1" title="下移" aria-label="下移"${index === editor.selected.length - 1 || editor.applying ? ' disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="sjbp-icon-button" data-template-remove="${index}" title="移除" aria-label="移除"${editor.applying ? ' disabled' : ''}><i class="fa-solid fa-xmark"></i></button>
              </div>
            </div>`).join('') : '<div class="sjbp-manual-empty">至少选择一个模板</div>'}
          </div>
          <p class="sjbp-template-merge-note">应用会协调当前聊天的表格结构并保留现有运行数据。若数据库判定变更具有破坏性，会拒绝应用并显示原因。</p>
          ${editor.error ? `<div class="sjbp-manual-error">${escapeHtml(editor.error)}</div>` : ''}
        </section>
      </main>
      <footer>
        <span>应用结果是当前聊天的独立模板快照，不要求原预设继续存在。</span>
        <div class="sjbp-footer-actions">
          <button type="button" class="sjbp-command-button" data-template-merge-cancel${editor.applying ? ' disabled' : ''}>取消</button>
          <button type="button" class="sjbp-command-button is-primary" data-template-merge-apply${!editor.selected.length || editor.applying ? ' disabled' : ''}>
            ${editor.applying ? '<i class="fa-solid fa-spinner fa-spin"></i> 正在应用' : '应用到当前对话'}
          </button>
        </div>
      </footer>
    </div>`;
  }

  function applyTemplateSourceFilter() {
    const editor = runtime.templateMergeEditor;
    if (!editor || !runtime.overlay) return;
    const needle = String(editor.filter || '').trim().toLocaleLowerCase();
    runtime.overlay.querySelectorAll('[data-template-source-row]').forEach(row => {
      row.hidden = !!needle && !String(row.dataset.searchText || '').includes(needle);
    });
  }

  async function applyTemplateMergeEditor() {
    const editor = runtime.templateMergeEditor;
    if (!editor || editor.applying || !editor.selected.length) return;
    editor.applying = true;
    editor.error = '';
    renderDialog();
    try {
      const result = await applyMergedTemplateSourcesToCurrentChat(
        editor.selected,
        `重新应用 ${editor.selected.length} 个表格模板`,
      );
      setManagedPreset('tablePreset', null);
      delete runtime.nativePresetAppliedTokens.tablePreset;
      runtime.lastApplySignature = '';
      runtime.templateMergeEditor = null;
      runtime.lastError = '';
      host.toastr?.success?.(`已应用 ${editor.selected.length} 个模板：${result.presetName}`);
      renderDialog();
    } catch (error) {
      if (runtime.templateMergeEditor !== editor) return;
      editor.applying = false;
      editor.error = String(error?.message || error);
      runtime.lastError = editor.error;
      renderDialog();
    }
  }

  function bindTemplateMergeEditorEvents() {
    const overlay = runtime.overlay;
    const editor = runtime.templateMergeEditor;
    if (!overlay || !editor) return;
    overlay.querySelectorAll('[data-template-merge-cancel]').forEach(button => {
      button.addEventListener('click', () => {
        if (editor.applying) return;
        runtime.templateMergeEditor = null;
        renderDialog();
      });
    });
    overlay.querySelector('[data-template-source-filter]')?.addEventListener('input', event => {
      editor.filter = event.currentTarget.value;
      applyTemplateSourceFilter();
    });
    overlay.querySelectorAll('[data-template-source]').forEach(input => {
      input.addEventListener('change', () => {
        const source = editor.catalog.find(item => item.key === input.dataset.templateSource);
        if (!source) return;
        if (input.checked && !editor.selected.some(item => item.key === source.key)) {
          editor.selected.push(clone(source));
        } else if (!input.checked) {
          editor.selected = editor.selected.filter(item => item.key !== source.key);
        }
        renderDialog();
      });
    });
    overlay.querySelectorAll('[data-template-move]').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.templateMove);
        const target = index + Number(button.dataset.direction);
        if (!Number.isInteger(index) || target < 0 || target >= editor.selected.length) return;
        [editor.selected[index], editor.selected[target]] = [editor.selected[target], editor.selected[index]];
        renderDialog();
      });
    });
    overlay.querySelectorAll('[data-template-remove]').forEach(button => {
      button.addEventListener('click', () => {
        editor.selected.splice(Number(button.dataset.templateRemove), 1);
        renderDialog();
      });
    });
    overlay.querySelector('[data-template-merge-apply]')?.addEventListener('click', () => {
      void applyTemplateMergeEditor();
    });
    applyTemplateSourceFilter();
  }

  function describeLastWriteWorldbookRefresh() {
    const transaction = runtime.writeWorldbookResetState;
    if (transaction?.status === 'running') {
      return `写入世界书：清空同步进行中 · ${transaction.reason}`;
    }
    if (transaction?.status === 'cancelled') return '写入世界书：旧对话同步已取消';
    const refresh = runtime.lastWriteWorldbookRefresh;
    if (!refresh?.at) return '最近写入刷新：尚无';
    const time = new Date(refresh.at).toLocaleTimeString('zh-CN', { hour12: false });
    return `最近写入刷新：${refresh.method} · ${refresh.reason} · ${time}`;
  }

  function buildDialogHtml() {
    if (runtime.panelLoading) {
      return `<div class="sjbp-dialog sjbp-loading-dialog" role="dialog" aria-modal="true" aria-labelledby="sjbp-title">
        <header>
          <div>
            <h2 id="sjbp-title">数据库三层绑定</h2>
            <p>正在读取当前对话与数据库状态</p>
          </div>
          <button type="button" class="sjbp-icon-button" data-close title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <main class="sjbp-loading" role="status" aria-live="polite">
          <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
          <strong>正在连接并核对绑定...</strong>
          <span>移动端加载较慢时，此窗口会在数据就绪后自动显示完整内容。</span>
        </main>
      </div>`;
    }
    if (runtime.manualEditor) return buildManualEditorHtml();
    if (runtime.templateMergeEditor) return buildTemplateMergeEditorHtml();
    const state = readState();
    const identity = getIdentity();
    const connected = !!runtime.settingsRef;
    const verification = connected ? getVerificationReport() : null;
    const verificationFailures = describeVerificationFailures(verification);
    const presetWarnings = describePresetWarnings();
    const connectedText = runtime.lastError ? runtime.lastError : verification?.deferred ? verification.message : verification?.ok
      ? `绑定已核验 ${verification.matched}/${verification.total}`
        + (presetWarnings.length ? `；预设警告：${presetWarnings.join('；')}` : '')
      : (connected
        ? `绑定未完全生效 ${verification?.matched || 0}/${verification?.total || 5}`
          + (verificationFailures.length ? `：${verificationFailures.join('、')}` : '')
          + (runtime.lastError ? `；错误：${runtime.lastError}` : '')
        : (runtime.lastError || '等待数据库运行时'));
    return `<div class="sjbp-dialog" role="dialog" aria-modal="true" aria-labelledby="sjbp-title">
      <header>
        <div>
          <h2 id="sjbp-title">数据库三层绑定</h2>
          <p>${escapeHtml(identity.characterLabel)} · ${escapeHtml(identity.chatKey || '未选择对话')} · ${escapeHtml(getIsolationKey())}</p>
        </div>
        <button type="button" class="sjbp-icon-button" data-close title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
      </header>
      ${buildActiveWorldbookSummary()}
      <main>
        ${FEATURE_IDS.map(feature => buildFeatureRow(feature, state)).join('')}
      </main>
      <footer>
        <div class="sjbp-footer-status">
          <span data-verification-status class="${verification?.ok ? 'is-ok' : 'is-error'}">${escapeHtml(connectedText)}</span>
          <small data-last-write-refresh>${escapeHtml(describeLastWriteWorldbookRefresh())}</small>
        </div>
        <div class="sjbp-footer-actions">
          <button type="button" class="sjbp-button sjbp-command-button" data-reset-write-worldbook title="先清空数据库生成条目，再按当前对话重新写入">
            <i class="fa-solid fa-arrows-rotate"></i><span>清空并更新写入世界书</span>
          </button>
          <button type="button" class="sjbp-icon-button" data-refresh title="重新连接并应用" aria-label="重新连接并应用"><i class="fa-solid fa-rotate"></i></button>
        </div>
      </footer>
    </div>`;
  }

  function installStyles() {
    const doc = host.document;
    if (!doc) return;
    let style = doc.getElementById('sjbp-styles');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'sjbp-styles';
      (doc.head || doc.documentElement).appendChild(style);
    }
    style.textContent = `
      #sjbp-overlay {
        position: fixed; inset: 0; z-index: 32000; background: rgba(12,16,18,.72);
        display: grid; place-items: center; padding: 18px; box-sizing: border-box;
        overscroll-behavior: contain;
      }
      #sjbp-overlay[hidden] { display: none; }
      #acu-app-v2.sjbp-headless { visibility: hidden !important; pointer-events: none !important; }
      .sjbp-dialog {
        width: min(880px, 96vw); max-height: min(820px, 92vh); overflow: auto;
        background: #171d20; color: #edf1f2; border: 1px solid #4a565b; border-radius: 8px;
        box-shadow: 0 18px 60px rgba(0,0,0,.46); font: 13px/1.5 system-ui, sans-serif;
        box-sizing: border-box; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
      }
      .sjbp-dialog header, .sjbp-dialog footer {
        display: flex; align-items: center; justify-content: space-between; gap: 14px;
        padding: 14px 16px; background: #20282c;
      }
      .sjbp-dialog header { position: sticky; top: 0; z-index: 2; border-bottom: 1px solid #3b464b; }
      .sjbp-loading-dialog { min-height: 190px; }
      .sjbp-loading {
        min-height: 120px; display: grid; place-items: center; align-content: center;
        gap: 10px; padding: 24px; text-align: center; color: #d7e1e4;
      }
      .sjbp-loading > i { font-size: 24px; }
      .sjbp-loading > span { max-width: 34rem; color: #aeb9bd; }
      .sjbp-dialog footer { position: sticky; bottom: 0; border-top: 1px solid #3b464b; }
      .sjbp-dialog h2 { margin: 0; font-size: 17px; letter-spacing: 0; }
      .sjbp-dialog p { margin: 2px 0 0; color: #aeb9bd; overflow-wrap: anywhere; }
      .sjbp-active { padding: 12px 16px; border-bottom: 1px solid #394247; background: #182327; }
      .sjbp-active > div { display: flex; justify-content: space-between; color: #d6e5dc; }
      .sjbp-active dl { display: grid; grid-template-columns: 112px minmax(0,1fr); gap: 4px 12px; margin: 8px 0 0; }
      .sjbp-active dt { color: #8fb5a1; }
      .sjbp-active dd { margin: 0; color: #c9d1d4; overflow-wrap: anywhere; }
      .sjbp-muted { color: #77858b; }
      .sjbp-row { padding: 13px 16px; border-bottom: 1px solid #30393d; }
      .sjbp-row-title { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 5px; }
      .sjbp-row-title strong { font-size: 13px; }
      .sjbp-binding-status { display: grid; gap: 3px; margin-bottom: 9px; color: #aeb9bd; }
      .sjbp-binding-status > div { display: grid; grid-template-columns: 66px minmax(0,1fr); gap: 8px; }
      .sjbp-binding-status b { color: #86b99f; font-weight: 600; }
      .sjbp-binding-status span { overflow-wrap: anywhere; }
      .sjbp-row-controls { display: grid; grid-template-columns: minmax(210px,1fr) auto 34px 34px; gap: 8px; align-items: end; }
      .sjbp-row-controls.sjbp-native-template-controls { grid-template-columns: minmax(0,1fr); align-items: stretch; }
      .sjbp-native-template-controls .sjbp-scopes { grid-template-columns: repeat(3,minmax(0,1fr)); height: 44px; }
      .sjbp-native-template-controls > button { min-height: 44px; }
      .sjbp-combobox { position: relative; min-width: 0; }
      .sjbp-select {
        width: 100%; min-width: 0; height: 34px; padding: 0 9px; border: 1px solid #556268;
        border-radius: 4px; background: #111719; color: #edf1f2;
        display: grid; grid-template-columns: minmax(0,1fr) 16px; align-items: center; gap: 8px;
        text-align: left; cursor: pointer;
      }
      .sjbp-select > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sjbp-select > i { color: #98a8ad; text-align: center; }
      .sjbp-select[aria-expanded="true"] { outline: 2px solid #4f8b70; outline-offset: 1px; }
      .sjbp-select-menu {
        position: fixed; z-index: 32020; min-width: 220px; max-height: min(360px, 60vh);
        display: grid; grid-template-rows: minmax(0,1fr); overflow: hidden;
        border: 1px solid #617078; border-radius: 6px; background: #151c1f;
        box-shadow: 0 14px 34px rgba(0,0,0,.5);
      }
      .sjbp-select-menu.has-filter { grid-template-rows: auto minmax(0,1fr); }
      .sjbp-select-menu[hidden] { display: none; }
      .sjbp-menu-filter { position: relative; display: block; min-width: 0; padding: 7px; background: #20282c; }
      .sjbp-menu-filter > i {
        position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
        color: #8fa0a6; pointer-events: none;
      }
      .sjbp-menu-filter > input {
        width: 100%; min-width: 0; height: 32px; box-sizing: border-box;
        padding: 0 30px 0 31px; border: 1px solid #4b585e; border-radius: 4px;
        background: #111719; color: #edf1f2;
      }
      .sjbp-menu-filter > input::placeholder { color: #7f8e94; opacity: 1; }
      .sjbp-menu-filter > input:focus { outline: 2px solid #4f8b70; outline-offset: 1px; }
      .sjbp-select-options { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 4px; }
      .sjbp-select-option {
        width: 100%; min-height: 34px; padding: 6px 8px; border: 0; border-radius: 3px;
        background: transparent; color: #dce3e5; display: grid;
        grid-template-columns: minmax(0,1fr) 16px; gap: 8px; align-items: center;
        text-align: left; cursor: pointer;
      }
      .sjbp-select-option[hidden], .sjbp-check-row[hidden], .sjbp-entry-group[hidden] {
        display: none !important;
      }
      .sjbp-select-option > span { overflow-wrap: anywhere; }
      .sjbp-select-option > i { visibility: hidden; color: #8fd0a8; }
      .sjbp-select-option:hover, .sjbp-select-option:focus-visible { background: #29353a; outline: none; }
      .sjbp-select-option.is-selected { background: #244537; color: #fff; }
      .sjbp-select-option.is-selected > i { visibility: visible; }
      .sjbp-worldbook-control {
        min-width: 0; display: grid; grid-template-columns: minmax(0,1fr) 34px; gap: 7px;
      }
      .sjbp-scopes { display: grid; grid-template-columns: repeat(3, 54px); height: 34px; }
      .sjbp-scopes button {
        border: 1px solid #556268; border-right-width: 0; background: #1a2226; color: #b9c4c8; cursor: pointer;
      }
      .sjbp-scopes button:first-child { border-radius: 4px 0 0 4px; }
      .sjbp-scopes button:last-child { border-right-width: 1px; border-radius: 0 4px 4px 0; }
      .sjbp-scopes button.is-active { background: #35644f; color: #fff; border-color: #4f8b70; }
      .sjbp-icon-button {
        width: 34px; height: 34px; border: 1px solid #566268; border-radius: 4px;
        background: #20292d; color: #eef2f3; display: grid; place-items: center; cursor: pointer;
      }
      .sjbp-icon-button:hover:not(:disabled) { background: #314147; }
      .sjbp-icon-button:disabled { opacity: .35; cursor: default; }
      .sjbp-table-preset-actions {
        margin-top: 9px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
      }
      .sjbp-toggle-row {
        min-width: 0; min-height: 34px; display: flex; align-items: center; gap: 8px; color: #c9d1d4;
      }
      .sjbp-toggle-row > input { width: 18px; height: 18px; margin: 0; accent-color: #4f8b70; }
      .sjbp-toggle-row > span { overflow-wrap: anywhere; }
      .sjbp-toggle-row.is-disabled { opacity: .48; }
      .sjbp-table-preset-actions .sjbp-command-button { display: inline-flex; align-items: center; gap: 7px; }
      .sjbp-embedded-preset-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
      .sjbp-command-button:disabled { opacity: .4; cursor: default; }
      .sjbp-footer-status { min-width: 0; display: grid; gap: 2px; }
      .sjbp-footer-status small { color: #aeb9bd; overflow-wrap: anywhere; }
      .sjbp-dialog footer .is-ok { color: #8fd0a8; }
      .sjbp-dialog footer .is-warning { color: #f2c66d; }
      .sjbp-dialog footer .is-error { color: #ef9a91; }
      .sjbp-manual-dialog { overflow: hidden; display: grid; grid-template-rows: auto minmax(0,1fr) auto; }
      .sjbp-manual-body {
        min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(230px,.8fr) minmax(330px,1.2fr);
        gap: 0; padding: 0;
      }
      .sjbp-manual-column { min-width: 0; padding: 13px 14px; border-right: 1px solid #394247; }
      .sjbp-manual-column:last-child { border-right: 0; }
      .sjbp-manual-heading { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .sjbp-manual-heading > span { color: #9fb1b7; }
      .sjbp-static-filter { padding: 0; margin: 7px 0; background: transparent; }
      .sjbp-static-filter > i { left: 10px; }
      .sjbp-check-list, .sjbp-entry-groups { display: grid; gap: 3px; }
      .sjbp-check-row {
        min-width: 0; min-height: 34px; display: grid; grid-template-columns: 18px minmax(0,1fr) auto;
        align-items: center; gap: 8px; padding: 5px 7px; border-radius: 3px; color: #dce3e5;
      }
      .sjbp-check-row:hover { background: #202a2e; }
      .sjbp-check-row > input { width: 16px; height: 16px; margin: 0; accent-color: #4f8b70; }
      .sjbp-check-row > span { min-width: 0; overflow-wrap: anywhere; }
      .sjbp-check-row > small { color: #8fb5a1; }
      .sjbp-check-row.is-disabled { opacity: .52; }
      .sjbp-entry-actions, .sjbp-footer-actions { display: flex; gap: 7px; }
      .sjbp-entry-group { border-bottom: 1px solid #30393d; }
      .sjbp-entry-group-title {
        width: 100%; min-height: 38px; padding: 6px 7px; border: 0; background: transparent; color: #edf1f2;
        display: grid; grid-template-columns: 16px minmax(0,1fr) auto; align-items: center; gap: 7px;
        text-align: left; cursor: pointer;
      }
      .sjbp-entry-group-title:hover { background: #202a2e; }
      .sjbp-entry-group-title > span { overflow-wrap: anywhere; }
      .sjbp-entry-group-title > small { color: #8fb5a1; }
      .sjbp-entry-list { padding: 0 0 6px 17px; }
      .sjbp-entry-groups.is-filtering .sjbp-entry-list { display: block !important; }
      .sjbp-manual-empty {
        min-height: 110px; display: flex; align-items: center; justify-content: center; gap: 8px;
        color: #8f9ea3; text-align: center;
      }
      .sjbp-manual-error {
        margin: 7px 0; padding: 7px 9px; border: 1px solid #834942; border-radius: 4px;
        background: #331f1d; color: #ffb7b0; overflow-wrap: anywhere;
      }
      .sjbp-command-button {
        min-height: 34px; padding: 0 13px; border: 1px solid #566268; border-radius: 4px;
        background: #20292d; color: #eef2f3; cursor: pointer;
      }
      .sjbp-command-button.is-primary { border-color: #4f8b70; background: #35644f; color: #fff; }
      .sjbp-manual-dialog footer > span { color: #aeb9bd; overflow-wrap: anywhere; }
      .sjbp-template-merge-dialog { overflow: hidden; display: grid; grid-template-rows: auto minmax(0,1fr) auto; }
      .sjbp-template-merge-body {
        min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(240px,.82fr) minmax(360px,1.18fr);
      }
      .sjbp-template-source-panel, .sjbp-template-order-panel { min-width: 0; padding: 13px 14px; }
      .sjbp-template-source-panel { border-right: 1px solid #394247; }
      .sjbp-template-order-list { display: grid; gap: 6px; margin-top: 7px; }
      .sjbp-template-order-row {
        min-width: 0; min-height: 46px; display: grid; grid-template-columns: 28px minmax(0,1fr) auto;
        align-items: center; gap: 8px; padding: 5px 7px; border: 1px solid #39474d; border-radius: 4px;
        background: #1c2529;
      }
      .sjbp-template-order-row > span:nth-child(2) { overflow-wrap: anywhere; }
      .sjbp-template-priority {
        width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%;
        background: #315846; color: #fff; font-size: 12px;
      }
      .sjbp-template-order-actions { display: flex; gap: 5px; }
      .sjbp-template-order-actions .sjbp-icon-button { width: 32px; height: 32px; }
      .sjbp-template-merge-note { margin: 12px 0 0; color: #9fb0b6; }
      .sjbp-template-merge-dialog footer > span { color: #aeb9bd; overflow-wrap: anywhere; }
      #acu-app-v2 .sjbp-db-active-status {
        margin-top: 6px; padding: 7px 9px; border: 1px solid color-mix(in srgb, var(--acu-accent) 42%, transparent);
        border-radius: var(--acu-radius-sm, 4px); background: color-mix(in srgb, var(--acu-accent) 12%, transparent);
        color: var(--acu-text-2, #c9d1d4); font-size: var(--acu-font-size-caption, 11px); line-height: 1.4;
        overflow-wrap: anywhere;
      }
      #acu-app-v2 .sjbp-db-active-status--error {
        border-color: color-mix(in srgb, #ef7367 55%, transparent);
        background: color-mix(in srgb, #ef7367 12%, transparent);
        color: #ffb7b0;
      }
      #acu-app-v2 .sjbp-db-source-is-active .acu-v2-wb-source-picker__list { display: none; }
      #acu-app-v2 .sjbp-db-active-source .acu-segmented__label { font-size: var(--acu-font-size-caption, 11px); }
      @media (max-width: 680px) {
        #sjbp-overlay {
          width: 100vw; height: 100dvh; min-height: 100dvh; padding: 6px;
          place-items: start center; overflow: hidden;
        }
        .sjbp-dialog { width: 100%; max-height: calc(100dvh - 12px); }
        .sjbp-dialog header, .sjbp-dialog footer { padding: 10px 11px; }
        .sjbp-active, .sjbp-row { padding: 10px 11px; }
        .sjbp-active dl { grid-template-columns: 88px minmax(0,1fr); gap: 4px 8px; }
        .sjbp-row-controls { grid-template-columns: 1fr 34px 34px; }
        .sjbp-row-controls > .sjbp-combobox, .sjbp-worldbook-control { grid-column: 1 / -1; }
        .sjbp-scopes { grid-template-columns: repeat(3, 1fr); }
        .sjbp-row-title { display: block; }
        .sjbp-binding-status > div { grid-template-columns: 62px minmax(0,1fr); gap: 6px; }
        .sjbp-select-menu {
          left: 6px !important; right: auto !important;
          width: calc(100vw - 12px) !important; max-height: min(66dvh, 480px);
        }
        .sjbp-manual-body { grid-template-columns: 1fr; }
        .sjbp-manual-column { border-right: 0; border-bottom: 1px solid #394247; padding: 10px 11px; }
        .sjbp-manual-column:last-child { border-bottom: 0; }
        .sjbp-table-preset-actions { align-items: stretch; flex-direction: column; }
        .sjbp-table-preset-actions .sjbp-command-button { justify-content: center; width: 100%; min-height: 44px; }
        .sjbp-embedded-preset-actions { display: grid; grid-template-columns: 1fr 1fr; }
        .sjbp-template-merge-body { grid-template-columns: 1fr; }
        .sjbp-template-source-panel { border-right: 0; border-bottom: 1px solid #394247; padding: 10px 11px; }
        .sjbp-template-order-panel { padding: 10px 11px; }
        .sjbp-template-order-row { grid-template-columns: 28px minmax(0,1fr); }
        .sjbp-template-order-actions { grid-column: 1 / -1; justify-content: flex-end; }
        .sjbp-template-order-actions .sjbp-icon-button { width: 44px; height: 44px; }
        .sjbp-dialog footer { align-items: stretch; flex-direction: column; }
        .sjbp-footer-actions { width: 100%; justify-content: flex-end; }
        .sjbp-footer-actions .sjbp-button { min-width: 0; min-height: 44px; }
        .sjbp-footer-actions .sjbp-button:first-child { flex: 1; }
      }
    `;
  }

  function refreshUiStatus() {
    const overlay = runtime.overlay;
    if (!overlay || overlay.hidden) return;
    const footer = overlay.querySelector('[data-verification-status]');
    if (!footer) return;
    const verification = runtime.settingsRef ? getVerificationReport() : null;
    const verificationFailures = describeVerificationFailures(verification);
    const presetWarnings = describePresetWarnings();
    footer.className = verification?.ok
      ? (presetWarnings.length ? 'is-warning' : 'is-ok')
      : 'is-error';
    footer.textContent = runtime.lastError ? runtime.lastError : verification?.deferred ? verification.message : verification?.ok
      ? `绑定已核验 ${verification.matched}/${verification.total}`
        + (presetWarnings.length ? `；预设警告：${presetWarnings.join('；')}` : '')
      : (runtime.settingsRef
        ? `绑定未完全生效 ${verification?.matched || 0}/${verification?.total || 5}`
          + (verificationFailures.length ? `：${verificationFailures.join('、')}` : '')
          + (runtime.lastError ? `；错误：${runtime.lastError}` : '')
        : (runtime.lastError || '等待数据库运行时'));
    const refresh = overlay.querySelector('[data-last-write-refresh]');
    if (refresh) refresh.textContent = describeLastWriteWorldbookRefresh();
  }

  async function copySelectedTablePresetToCharacter() {
    try {
      const current = normalizeCharacterTablePresetBindingCore(
        getControlValue('tablePreset', 'character'),
      );
      if (current.source === 'embedded') {
        throw new Error('当前选择已经是内嵌预设；请先选择要复制的全局预设');
      }
      const sourceName = current.presetName;
      const suggestedName = sourceName || `${getIdentity().characterLabel || '角色'}表格预设`;
      const requestedName = host.prompt?.('内嵌预设名称', suggestedName);
      if (requestedName === null || requestedName === undefined) return;
      const name = String(requestedName || '').trim();
      if (!name) throw new Error('内嵌预设名称不能为空');
      const source = sourceName
        ? { type: 'preset', name: sourceName, label: sourceName }
        : { type: 'global', label: '当前全局模板' };
      const preset = saveEmbeddedTablePreset({
        name,
        template: getTemplateSnapshotFromDatabase(source),
        source: {
          type: sourceName ? 'globalPreset' : 'globalDefault',
          name: sourceName,
          copiedAt: Date.now(),
        },
      });
      setControlDraft('tablePreset', 'character', {
        source: 'embedded',
        presetName: '',
        embeddedPresetId: preset.id,
        mergeGlobal: current.mergeGlobal,
      });
      runtime.lastError = '';
      host.toastr?.success?.(`已复制为角色内嵌预设：${preset.name}`);
      renderDialog();
    } catch (error) {
      runtime.lastError = String(error?.message || error);
      host.toastr?.error?.(runtime.lastError);
      refreshUiStatus();
    }
  }

  async function copySelectedEmbeddedPresetToGlobal() {
    try {
      const current = normalizeCharacterTablePresetBindingCore(
        getControlValue('tablePreset', 'character'),
      );
      if (current.source !== 'embedded' || !current.embeddedPresetId) {
        throw new Error('请先选择一个角色内嵌预设');
      }
      const preset = getEmbeddedTablePreset(current.embeddedPresetId);
      if (!preset) throw new Error('所选角色内嵌预设已经不存在');

      const requestedName = host.prompt?.('复制到全局的预设名称', preset.name);
      if (requestedName === null || requestedName === undefined) return;
      const presetName = String(requestedName || '').trim();
      if (!presetName) throw new Error('全局预设名称不能为空');

      const api = getDatabaseApi();
      if (typeof api?.importTemplateFromData !== 'function') {
        throw new Error('数据库缺少 importTemplateFromData API');
      }
      if (typeof api.getTemplatePresetNames !== 'function') {
        throw new Error('数据库缺少 getTemplatePresetNames API，无法安全确认同名覆盖');
      }
      const existingNames = uniqueNames(api.getTemplatePresetNames());
      if (
        existingNames.includes(presetName)
        && !host.confirm?.(`全局预设“${presetName}”已存在，是否覆盖？`)
      ) {
        return;
      }

      const result = await api.importTemplateFromData(preset.template, {
        scope: 'global',
        presetName,
      });
      const outcome = normalizePresetApiResultCore(result);
      if (!outcome.success || !outcome.saved) {
        throw new Error(`复制到全局失败: ${outcome.error || '数据库未保存预设'}`);
      }

      await captureDatabaseSettings(true);
      runtime.lastError = '';
      host.toastr?.success?.(`已复制角色内嵌预设到全局：${presetName}`);
      if (outcome.warning) host.toastr?.warning?.(outcome.warning);
      renderDialog();
    } catch (error) {
      runtime.lastError = String(error?.message || error);
      host.toastr?.error?.(runtime.lastError);
      refreshUiStatus();
    }
  }

  function deleteSelectedCharacterEmbeddedPreset() {
    try {
      const current = normalizeCharacterTablePresetBindingCore(
        getControlValue('tablePreset', 'character'),
      );
      if (current.source !== 'embedded' || !current.embeddedPresetId) {
        throw new Error('请先选择一个角色内嵌预设');
      }
      const preset = getEmbeddedTablePreset(current.embeddedPresetId);
      if (!preset) throw new Error('所选角色内嵌预设已经不存在');
      if (!host.confirm?.(`删除角色内嵌预设“${preset.name}”？`)) return;
      if (!deleteEmbeddedTablePreset(preset.id)) throw new Error('删除角色内嵌预设失败');
      clearControlDraft('tablePreset', 'character');
      runtime.lastApplySignature = '';
      runtime.lastError = '';
      host.toastr?.success?.(`已删除角色内嵌预设：${preset.name}`);
      renderDialog();
    } catch (error) {
      runtime.lastError = String(error?.message || error);
      host.toastr?.error?.(runtime.lastError);
      refreshUiStatus();
    }
  }

  async function captureSelectedFeature(feature, requestedScope = '') {
    assertBindingScopeAvailable(SCOPE_IDS.includes(requestedScope) ? requestedScope : getEditScope(feature));
    if (!runtime.settingsRef && !await captureDatabaseSettings(false)) {
      runtime.lastError = '尚未连接数据库运行时，不能建立绑定';
      refreshUiStatus();
      return;
    }
    const overlay = runtime.overlay;
    const select = overlay?.querySelector(`[data-control="${feature}"]`);
    const scope = SCOPE_IDS.includes(requestedScope) ? requestedScope : getEditScope(feature);
    const selected = String(select?.value ?? '');
    const controlValue = getControlValue(feature, scope);
    let value;

    if (feature === 'writeWorldbook') {
      value = selected || 'character';
    } else if (feature === 'tableWorldbooks') {
      value = {
        source: selected,
        manualSelection: selected === 'manual' ? clone(controlValue?.manualSelection || []) : [],
        enabledEntries: selected === 'manual' ? clone(controlValue?.enabledEntries || {}) : {},
      };
    } else if (feature === 'plotWorldbooks') {
      value = {
        source: selected,
        manualSelection: selected === 'manual' ? clone(controlValue?.manualSelection || []) : [],
        enabledEntries: selected === 'manual' ? clone(controlValue?.enabledEntries || {}) : {},
      };
    } else if (feature === 'tablePreset' && scope === 'character') {
      value = parseTablePresetSelectionCore(
        selected,
        !!overlay?.querySelector('[data-table-merge-global]')?.checked,
      );
    } else {
      value = selected;
    }

    await setBindingForScope(feature, scope, value);
    clearControlDraft(feature, scope);
    runtime.lastApplySignature = '';
    await applyBindings(
      `绑定 ${FEATURE_LABELS[feature]} / ${SCOPE_LABELS[scope]}`,
      true,
      false,
      false,
      feature === 'writeWorldbook' && !!getIdentity().chatKey,
    );
    if (isPatchOwnedBindingScope(feature, scope)) {
      await setBindingForScope(feature, scope, value);
      if (!bindingAtScopeMatches(feature, scope, value)) {
        runtime.lastError = `${SCOPE_LABELS[scope]}${FEATURE_LABELS[feature]}绑定未能持久化`;
      }
    }
    setEditScope(feature, scope);
    renderDialog();
  }

  async function clearSelectedFeature(feature, requestedScope = '') {
    const scope = SCOPE_IDS.includes(requestedScope) ? requestedScope : getEditScope(feature);
    assertBindingScopeAvailable(scope);
    const scopeBinding = getBindingAtScope(feature, scope);
    const draft = getControlDraft(feature, scope);
    if (scopeBinding === undefined && draft !== undefined) {
      clearControlDraft(feature, scope);
      renderDialog();
      return;
    }
    await clearBindingForScope(feature, scope);
    clearControlDraft(feature, scope);
    runtime.lastApplySignature = '';
    await applyBindings(
      `解绑 ${FEATURE_LABELS[feature]} / ${SCOPE_LABELS[scope]}`,
      true,
      false,
      false,
      feature === 'writeWorldbook' && !!getIdentity().chatKey,
    );
    if (isPatchOwnedBindingScope(feature, scope)) {
      await clearBindingForScope(feature, scope);
      if (getBindingAtScope(feature, scope) !== undefined) {
        runtime.lastError = `${SCOPE_LABELS[scope]}${FEATURE_LABELS[feature]}解绑未能持久化`;
      }
    }
    setEditScope(feature, scope);
    renderDialog();
  }

  function closeChoiceMenus(exceptFeature = '') {
    const overlay = runtime.overlay;
    if (!overlay) return;
    overlay.querySelectorAll('[data-select-menu]').forEach(menu => {
      if (menu.dataset.selectMenu === exceptFeature) return;
      menu.hidden = true;
      const trigger = overlay.querySelector(`[data-select-trigger="${menu.dataset.selectMenu}"]`);
      trigger?.setAttribute('aria-expanded', 'false');
    });
  }

  function positionChoiceMenu(trigger, menu) {
    const rect = trigger.getBoundingClientRect();
    const viewportHeight = host.innerHeight || host.document.documentElement.clientHeight || 800;
    const viewportWidth = host.innerWidth || host.document.documentElement.clientWidth || 1280;
    if (viewportWidth <= 680) {
      const maxHeight = Math.min(480, viewportHeight * 0.66);
      const measuredHeight = Math.min(menu.scrollHeight || maxHeight, maxHeight);
      menu.style.width = `${Math.max(0, viewportWidth - 12)}px`;
      menu.style.left = '6px';
      menu.style.right = 'auto';
      menu.style.bottom = 'auto';
      menu.style.top = `${Math.max(6, viewportHeight - measuredHeight - 6)}px`;
      return;
    }
    const width = Math.max(rect.width, Math.min(360, viewportWidth - 12));
    menu.style.width = `${Math.min(width, viewportWidth - 12)}px`;
    menu.style.left = `${Math.max(6, Math.min(rect.left, viewportWidth - width - 6))}px`;
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.top = `${rect.bottom + 4}px`;
    const measuredHeight = Math.min(menu.scrollHeight || 360, Math.min(360, viewportHeight * 0.6));
    if (rect.bottom + measuredHeight + 8 > viewportHeight && rect.top > measuredHeight + 8) {
      menu.style.top = `${Math.max(6, rect.top - measuredHeight - 4)}px`;
    }
  }

  function updateControlDraftFromSelection(feature, selected) {
    const state = readState();
    const scope = getEditScope(feature, state);
    if (feature === 'tableWorldbooks' || feature === 'plotWorldbooks') {
      const current = getControlValue(feature, scope);
      setControlDraft(feature, scope, {
        source: selected,
        manualSelection: selected === 'manual' ? clone(current?.manualSelection || []) : [],
        enabledEntries: selected === 'manual' ? clone(current?.enabledEntries || {}) : {},
      });
      return;
    }
    if (feature === 'tablePreset' && scope === 'character') {
      const current = normalizeCharacterTablePresetBindingCore(getControlValue(feature, scope));
      setControlDraft(
        feature,
        scope,
        parseTablePresetSelectionCore(selected, selected ? current.mergeGlobal : false),
      );
      return;
    }
    setControlDraft(feature, scope, selected);
  }

  function bindChoiceMenus() {
    const overlay = runtime.overlay;
    if (!overlay) return;
    runtime.choiceMenuDisposer?.();
    runtime.choiceMenuDisposer = null;

    overlay.querySelectorAll('[data-select-trigger]').forEach(trigger => {
      trigger.addEventListener('click', () => {
        const feature = trigger.dataset.selectTrigger;
        const menu = overlay.querySelector(`[data-select-menu="${feature}"]`);
        if (!menu) return;
        const opening = menu.hidden;
        closeChoiceMenus(opening ? feature : '');
        menu.hidden = !opening;
        trigger.setAttribute('aria-expanded', String(opening));
        if (!opening) return;
        positionChoiceMenu(trigger, menu);
        const input = menu.querySelector('[data-menu-filter]');
        if (input) {
          input.value = '';
          menu.querySelectorAll('[data-select-option]').forEach(optionElement => {
            optionElement.hidden = false;
          });
          queueMicrotask(() => input.focus());
        }
      });
    });

    overlay.querySelectorAll('[data-menu-filter]').forEach(input => {
      const feature = input.dataset.menuFilter;
      const menu = overlay.querySelector(`[data-select-menu="${feature}"]`);
      const select = overlay.querySelector(`[data-control="${feature}"]`);
      const options = [...(menu?.querySelectorAll('[data-select-option]') || [])].map(element => ({
        value: element.dataset.value || '',
        label: element.dataset.label || element.textContent || '',
        element,
      }));
      const applyFilter = () => {
        const visibleValues = new Set(
          filterChoiceOptionsCore(options, input.value, select?.value).map(item => item.value),
        );
        options.forEach(item => {
          item.element.hidden = !visibleValues.has(item.value);
        });
      };
      input.addEventListener('input', applyFilter);
      input.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (input.value) {
          input.value = '';
          applyFilter();
        } else {
          closeChoiceMenus();
          overlay.querySelector(`[data-select-trigger="${feature}"]`)?.focus();
        }
      });
    });

    overlay.querySelectorAll('[data-select-option]').forEach(optionElement => {
      optionElement.addEventListener('click', () => {
        updateControlDraftFromSelection(optionElement.dataset.selectOption, optionElement.dataset.value || '');
        renderDialog();
      });
    });

    const outsideHandler = event => {
      if (!event.target?.closest?.('.sjbp-combobox')) closeChoiceMenus();
    };
    host.document.addEventListener('pointerdown', outsideHandler, true);
    runtime.choiceMenuDisposer = () => host.document.removeEventListener('pointerdown', outsideHandler, true);
  }

  function applyManualEditorFilters() {
    const editor = runtime.manualEditor;
    const overlay = runtime.overlay;
    if (!editor || !overlay) return;
    const bookNeedle = String(editor.bookFilter || '').trim().toLocaleLowerCase();
    overlay.querySelectorAll('[data-book-row]').forEach(row => {
      row.hidden = !!bookNeedle && !String(row.dataset.searchText || '').includes(bookNeedle);
    });
    const entryNeedle = String(editor.entryFilter || '').trim().toLocaleLowerCase();
    const groupsRoot = overlay.querySelector('[data-manual-entry-groups]');
    groupsRoot?.classList.toggle('is-filtering', !!entryNeedle);
    overlay.querySelectorAll('[data-entry-group]').forEach(group => {
      const rows = [...group.querySelectorAll('[data-entry-row]')];
      let visibleCount = 0;
      rows.forEach(row => {
        const visible = !entryNeedle || String(row.dataset.searchText || '').includes(entryNeedle);
        row.hidden = !visible;
        if (visible) visibleCount += 1;
      });
      group.hidden = !!entryNeedle && visibleCount === 0;
    });
  }

  function bindManualEditorEvents() {
    const overlay = runtime.overlay;
    const editor = runtime.manualEditor;
    if (!overlay || !editor) return;
    overlay.querySelectorAll('[data-manual-cancel]').forEach(button => {
      button.addEventListener('click', () => {
        runtime.manualEditor = null;
        renderDialog();
      });
    });
    overlay.querySelector('[data-manual-save]')?.addEventListener('click', () => {
      setControlDraft(editor.feature, editor.scope, {
        source: 'manual',
        manualSelection: clone(editor.bookNames),
        enabledEntries: clone(editor.enabledEntries),
      });
      runtime.manualEditor = null;
      renderDialog();
    });
    overlay.querySelector('[data-manual-book-filter]')?.addEventListener('input', event => {
      editor.bookFilter = event.currentTarget.value;
      applyManualEditorFilters();
    });
    overlay.querySelector('[data-manual-entry-filter]')?.addEventListener('input', event => {
      editor.entryFilter = event.currentTarget.value;
      applyManualEditorFilters();
    });
    overlay.querySelectorAll('[data-manual-book]').forEach(input => {
      input.addEventListener('change', () => {
        const name = input.dataset.manualBook;
        if (input.checked) {
          editor.bookNames = uniqueNames([...editor.bookNames, name]);
          editor.expandedBooks = uniqueNames([...editor.expandedBooks, name]);
          void loadManualEditorEntries([name]);
        } else {
          editor.bookNames = editor.bookNames.filter(item => item !== name);
          editor.expandedBooks = editor.expandedBooks.filter(item => item !== name);
          rebuildManualEditorGroups();
          renderDialog();
        }
      });
    });
    overlay.querySelectorAll('[data-toggle-entry-group]').forEach(button => {
      button.addEventListener('click', () => {
        const name = button.dataset.toggleEntryGroup;
        editor.expandedBooks = editor.expandedBooks.includes(name)
          ? editor.expandedBooks.filter(item => item !== name)
          : uniqueNames([...editor.expandedBooks, name]);
        rebuildManualEditorGroups();
        renderDialog();
      });
    });
    overlay.querySelectorAll('[data-manual-entry]').forEach(input => {
      input.addEventListener('change', () => {
        const bookName = input.dataset.book;
        const group = editor.groups.find(item => item.bookName === bookName);
        const entry = group?.entries.find(item => String(item.uid) === String(input.dataset.manualEntry));
        if (!entry) return;
        const current = Array.isArray(editor.enabledEntries[bookName])
          ? [...editor.enabledEntries[bookName]]
          : [];
        const index = current.findIndex(uid => String(uid) === String(entry.uid));
        if (input.checked && index === -1) current.push(entry.uid);
        if (!input.checked && index !== -1) current.splice(index, 1);
        editor.enabledEntries[bookName] = current;
        rebuildManualEditorGroups();
        const counter = input.closest('[data-entry-group]')?.querySelector('.sjbp-entry-group-title small');
        if (counter) {
          const updated = editor.groups.find(item => item.bookName === bookName);
          counter.textContent = `${updated.entries.filter(item => item.checked).length}/${updated.entries.length}`;
        }
      });
    });
    overlay.querySelector('[data-entry-select-all]')?.addEventListener('click', () => {
      for (const group of editor.groups) {
        editor.enabledEntries[group.bookName] = group.entries
          .filter(entry => !entry.disabled)
          .map(entry => entry.uid);
      }
      rebuildManualEditorGroups();
      renderDialog();
    });
    overlay.querySelector('[data-entry-select-none]')?.addEventListener('click', () => {
      for (const group of editor.groups) editor.enabledEntries[group.bookName] = [];
      rebuildManualEditorGroups();
      renderDialog();
    });
    applyManualEditorFilters();
  }

  function bindDialogEvents() {
    const overlay = runtime.overlay;
    if (!overlay) return;
    if (runtime.manualEditor) {
      runtime.choiceMenuDisposer?.();
      runtime.choiceMenuDisposer = null;
      bindManualEditorEvents();
      return;
    }
    if (runtime.templateMergeEditor) {
      runtime.choiceMenuDisposer?.();
      runtime.choiceMenuDisposer = null;
      bindTemplateMergeEditorEvents();
      return;
    }
    overlay.querySelector('[data-close]')?.addEventListener('click', closeDialog);
    overlay.querySelector('[data-refresh]')?.addEventListener('click', async () => {
      if (!runtime.settingsRef) await captureDatabaseSettings(false);
      await refreshActiveWorldbooks();
      await applyBindings('手动刷新', true, true);
      renderDialog();
    });
    overlay.querySelector('[data-reset-write-worldbook]')?.addEventListener('click', async () => {
      await requestWriteWorldbookReset(
        '手动清空并更新写入世界书',
        { notifyIfBusy: true, allowCurrentDatabaseState: true },
      );
      renderDialog();
      return true;
    });
    overlay.querySelectorAll('[data-scope-feature]').forEach(button => {
      button.addEventListener('click', () => {
        setEditScope(button.dataset.scopeFeature, button.dataset.scope);
        renderDialog();
      });
    });
    overlay.querySelectorAll('[data-bind]').forEach(button => {
      button.addEventListener('click', () => void runBindingUiAction(() => captureSelectedFeature(
        button.dataset.bind,
        button.dataset.bindScope,
      )));
    });
    overlay.querySelectorAll('[data-clear]').forEach(button => {
      button.addEventListener('click', () => void runBindingUiAction(() => clearSelectedFeature(
        button.dataset.clear,
        button.dataset.clearScope,
      )));
    });
    overlay.querySelectorAll('[data-edit-manual]').forEach(button => {
      button.addEventListener('click', () => void runBindingUiAction(() => openManualEditor(button.dataset.editManual)));
    });
    overlay.querySelector('[data-table-merge-global]')?.addEventListener('change', event => {
      const current = normalizeCharacterTablePresetBindingCore(getControlValue('tablePreset', 'character'));
      setControlDraft('tablePreset', 'character', {
        source: current.source,
        presetName: current.presetName,
        embeddedPresetId: current.embeddedPresetId,
        mergeGlobal: event.currentTarget.checked,
      });
      renderDialog();
    });
    overlay.querySelector('[data-copy-embedded-table]')?.addEventListener(
      'click',
      () => void copySelectedTablePresetToCharacter(),
    );
    overlay.querySelector('[data-copy-embedded-to-global]')?.addEventListener(
      'click',
      () => void copySelectedEmbeddedPresetToGlobal(),
    );
    overlay.querySelector('[data-delete-embedded-table]')?.addEventListener(
      'click',
      deleteSelectedCharacterEmbeddedPreset,
    );
    overlay.querySelector('[data-open-native-template]')?.addEventListener('click', () => void openNativeTableTemplate());
    overlay.querySelector('[data-open-template-merge]')?.addEventListener('click', () => void runBindingUiAction(openTemplateMergeEditor));
    bindChoiceMenus();
  }

  function renderDialog() {
    if (!runtime.overlay) return;
    const previousDialog = runtime.overlay.querySelector('.sjbp-dialog');
    captureDialogScrollStateCore(runtime, runtime.overlay, previousDialog);
    runtime.overlay.innerHTML = buildDialogHtml();
    bindDialogEvents();
    restoreDialogScrollStateCore(runtime, runtime.overlay, !!runtime.manualEditor);
  }

  async function openDialog() {
    installStyles();
    if (!runtime.overlay) {
      runtime.overlay = host.document.createElement('div');
      runtime.overlay.id = 'sjbp-overlay';
      runtime.overlay.hidden = true;
      runtime.overlay.addEventListener('pointerdown', event => {
        if (event.target === runtime.overlay) closeDialog();
      });
      host.document.body.appendChild(runtime.overlay);
    }
    runtime.overlay.hidden = false;
    runtime.panelLoading = !runtime.settingsRef;
    renderDialog();
    try {
      await applyBindings('打开绑定面板', true);
    } finally {
      runtime.panelLoading = false;
      renderDialog();
    }
  }

  function closeDialog() {
    runtime.manualEditor = null;
    runtime.templateMergeEditor = null;
    closeChoiceMenus();
    runtime.choiceMenuDisposer?.();
    runtime.choiceMenuDisposer = null;
    if (runtime.overlay) runtime.overlay.hidden = true;
  }

  function installMenuItem() {
    const doc = host.document;
    const menu = doc?.getElementById('extensionsMenu');
    if (!menu) return false;

    let container = doc.getElementById('sjbp-menu-container');
    let item = doc.getElementById('sjbp-menu-item');
    if (!container) {
      container = doc.createElement('div');
      container.id = 'sjbp-menu-container';
      container.className = 'extension_container';
    }
    if (!item) {
      item = doc.createElement('div');
      item.id = 'sjbp-menu-item';
      item.className = 'list-group-item flex-container flexGap5 interactable';
      item.tabIndex = 0;
      item.setAttribute('role', 'listitem');
      item.innerHTML = `
        <div class="fa-fw fa-solid fa-link extensionsMenuExtensionButton"></div>
        <span>数据库三层绑定</span>
      `;
      item.addEventListener('click', () => void openDialog());
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void openDialog();
        }
      });
      container.appendChild(item);
    }
    if (container.parentElement !== menu) menu.appendChild(container);
    runtime.menuContainer = container;
    runtime.menuItem = item;
    return true;
  }

  function diagnose() {
    const identity = getIdentity();
    return {
      patch: `${PATCH_NAME} ${PATCH_VERSION}`,
      databaseSourceTag: getDatabaseSourceTag(),
      databaseApi: !!getDatabaseApi(),
      databaseFrame: !!findDatabaseFrame(),
      settingsCaptured: !!runtime.settingsRef,
      databaseProfileKey: runtime.databaseProfileKey,
      apiBoundary: {
        worldbooks: 'Tavern Helper globals',
        persona: 'Tavern Helper globals',
        events: 'Tavern Helper globals',
        character: 'Tavern Helper globals',
        patchSettings: 'Tavern Helper script variables (global/UI) + character variables (character bindings/embedded presets)',
        variableApiMode: runtime.variableApiMode,
        chatBindings: 'Tavern Helper chat variables',
        characterBindings: 'Tavern Helper character variables embedded in character card',
        sillyTavernDirect: [
          'current chat id',
          'group identity',
          'database-owned chat metadata/message fields',
        ],
        parentWindowDirect: [
          'AutoCardUpdaterAPI',
          'database iframe and host UI DOM',
        ],
      },
      isolationKey: getIsolationKey(),
      characterKey: identity.characterKey,
      chatKey: identity.chatKey,
      activeWorldbooks: clone(runtime.activeWorldbooks),
      resolvedBindings: Object.fromEntries(FEATURE_IDS.map(feature => [feature, resolveBinding(feature)])),
      verification: getVerificationReport(),
      lastApplyReason: runtime.lastApplyReason,
      lastApplyAt: runtime.lastApplyAt,
      lastWorldbookTransition: clone(runtime.lastWorldbookTransition),
      lastWriteWorldbookRefresh: clone(runtime.lastWriteWorldbookRefresh),
      writeWorldbookResetState: clone(runtime.writeWorldbookResetState),
      pendingWriteWorldbookTransition: clone(runtime.pendingWriteWorldbookTransition),
      presetWarnings: clone(runtime.presetWarnings),
      presetRetryAttempts: clone(runtime.presetRetryAttempts),
      lastError: runtime.lastError,
    };
  }

  function exposeApi() {
    if (typeof initializeGlobal !== 'function') {
      throw new Error('酒馆助手 initializeGlobal 尚不可用');
    }
    const api = {
      version: PATCH_VERSION,
      open: openDialog,
      close: closeDialog,
      diagnose,
      verify: async () => {
        await applyBindings('API verify', true);
        return getVerificationReport();
      },
      getState: readState,
      getCharacterData: () => clone(readCharacterPatchRoot()),
      getEmbeddedTablePresets,
      saveEmbeddedTablePreset,
      deleteEmbeddedTablePreset,
      getActiveWorldbooks: () => clone(runtime.activeWorldbooks),
      refreshActiveWorldbooks,
      refreshWriteWorldbook: () => applyBindings('API 写入世界书刷新', true, false, true, true),
      resetWriteWorldbook: () => requestWriteWorldbookReset(
        'API 清空并更新写入世界书',
        { notifyIfBusy: true, allowCurrentDatabaseState: true },
      ),
      apply: () => applyBindings('API', true),
      recaptureRuntime: async () => {
        runtime.settingsRef = null;
        return captureDatabaseSettings(true);
      },
          setBinding: async (feature, scope, value) => {
            await setBindingForScope(feature, scope, value);
            return applyBindings(
              'API setBinding',
              true,
              false,
              false,
              feature === 'writeWorldbook' && !!getIdentity().chatKey,
            );
          },
          clearBinding: async (feature, scope) => {
            await clearBindingForScope(feature, scope);
            return applyBindings(
              'API clearBinding',
              true,
              false,
              false,
              feature === 'writeWorldbook' && !!getIdentity().chatKey,
            );
          },
      setEnabled: async enabled => {
        const state = readState();
        state.enabled = !!enabled;
        writeState(state);
        return applyBindings('API setEnabled', true);
      },
    };
    runtime.api = api;
    initializeGlobal('ShujukuScopeBindingPatch', api);
    runtime.open = openDialog;
  }

  function destroy() {
    runtime.started = false;
    invalidateBindingContext();
    clearTimeout(runtime.applyTimer);
    clearTimeout(runtime.databaseUiTimer);
    clearTimeout(runtime.postCaptureReapplyTimer);
    resetPresetRuntimeState();
    for (const timer of Object.values(runtime.databaseUiSyncTimers)) clearTimeout(timer);
    for (const timer of runtime.databaseUiOpenTimers) clearTimeout(timer);
    clearInterval(runtime.pollTimer);
    runtime.mutationObserver?.disconnect?.();
    if (runtime.databaseTableCallbackApi && runtime.databaseTableCallback) {
      try {
        runtime.databaseTableCallbackApi.unregisterTableUpdateCallback?.(
          runtime.databaseTableCallback,
        );
      } catch (_) {
        // Ignore database runtime teardown races.
      }
    }
    runtime.choiceMenuDisposer?.();
    for (const dispose of runtime.eventDisposers.splice(0)) dispose();
    runtime.overlay?.remove?.();
    runtime.menuContainer?.remove?.();
    restorePublishedGlobalCore(
      host,
      'ShujukuScopeBindingPatch',
      runtime.api,
      runtime.previousHostApi,
      typeof initializeGlobal === 'function' ? initializeGlobal : null,
    );
    if (host[RUNTIME_KEY] === runtime) delete host[RUNTIME_KEY];
  }
  runtime.destroy = destroy;

  async function main() {
    if (!runtime.started) return;
    disableLegacyPatch();
    installStyles();
    installMenuItem();
    exposeApi();
    installEventListeners();
    installDatabaseUiIntegration();
    installDatabaseTableUpdateMonitor();

    for (let index = 0; index < 80 && runtime.started && !runtime.settingsRef; index += 1) {
      await captureDatabaseSettings(false);
      if (!runtime.started) return;
      if (!runtime.settingsRef) await new Promise(resolve => setTimeout(resolve, 250));
    }
    // A hot reload may destroy this instance while initialization is awaiting.
    if (!runtime.started) return;
    if (runtime.settingsRef) {
      writeState(readState());
      getCharacterBindings();
      await migrateLegacyPresetBindings();
    }
    if (!runtime.started) return;
    await refreshActiveWorldbooks();
    if (!runtime.started) return;
    await applyBindings('启动', true);
    if (!runtime.started) return;
    schedulePostCaptureReapply('启动后复核');

    runtime.pollTimer = setInterval(() => {
      if (!runtime.started) return;
      const frame = findDatabaseFrame();
      const frameWindow = (() => {
        try {
          return frame?.contentWindow || null;
        } catch (_) {
          return null;
        }
      })();
      if (
        runtime.dbFrame
        && (frame !== runtime.dbFrame || frameWindow !== runtime.dbFrameWindow || getDatabaseApi() !== runtime.dbApi)
      ) {
        const resumeWorldbookReset = !!runtime.pendingWriteWorldbookTransition;
        invalidateBindingContext();
        runtime.dbFrame = frame;
        runtime.dbFrameWindow = frameWindow;
        runtime.dbApi = getDatabaseApi();
        runtime.settingsRef = null;
        runtime.settingsGeneration += 1;
        runtime.nativePresetAppliedTokens = {};
        resetPresetRuntimeState();
        runtime.lastApplySignature = '';
        if (resumeWorldbookReset && getIdentity().chatKey) {
          beginWriteWorldbookTransition('数据库运行时重载');
          schedulePostCaptureReapply('数据库重载后世界书复核', 1800, true, true);
        }
      }
      if (!runtime.settingsRef) {
        void captureDatabaseSettings(false).then(settings => {
          if (runtime.started && settings) {
            scheduleApply('数据库重载', 300, true);
            schedulePostCaptureReapply('数据库重载后复核');
          }
        });
      }
      runtime.trackDatabaseUiVisibility?.();
      installDatabaseTableUpdateMonitor();
      installMenuItem();
    }, 3000);
    log(`已启动 v${PATCH_VERSION}。控制台 API: ShujukuScopeBindingPatch`);
  }

  void main();
})();
