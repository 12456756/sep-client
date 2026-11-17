import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PersonalSkillVersionRequest } from '../../shared/platform-supplement-contracts';
import type { SaveSkillResult, SkillLibraryItem } from '../../shared/skill-library';
import { FOLLOW_PLATFORM_SKILL_VERSION } from '../../shared/skill-library';
import type { SkillRewriteInput, SkillRewriteResult } from '../../shared/skill-rewrite';
import { classifySkillLoadError, formatSkillRateLimitMessage, type SkillLoadError, type SkillLoadErrorKind } from './skill-load-state';

/** Server metadata and durable local versions only. No browser-side skill copies. */
export function useSkillLibrary(scopeKey: string, enabled = true) {
  const identity = useMemo(() => ({ scopeKey, active: true }), [scopeKey]);
  useLayoutEffect(() => { identity.active = true; return () => { identity.active = false; }; }, [identity]);
  const [skills, setSkills] = useState<SkillLibraryItem[]>([]);
  const [stateScopeKey, setStateScopeKey] = useState(scopeKey);
  const [skillsLoading, setLoading] = useState(enabled);
  const [skillsWarning, setSkillsWarning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<SkillLoadError | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const generation = useRef(0);
  const loadErrorRef = useRef<SkillLoadError | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const inFlightRequest = useRef<number | null>(null);
  const retryTarget = useRef<string | undefined>();
  const autoRetryUsed = useRef(false);
  const requestTarget = useRef<string | undefined>();

  const captureFailure = useCallback((error: unknown, capabilityId?: string, retryAt?: number): SkillLoadError => {
    const failure = error && typeof error === 'object' && 'kind' in error
      ? error as SkillLoadError : classifySkillLoadError(error);
    if (!identity.active) return failure;
    if (failure.kind === 'auth' || failure.kind === 'forbidden') setSkills([]);
    if (failure.kind === 'rate-limited') failure.retryAt ??= retryAt ?? Date.now() + failure.retryAfterSeconds! * 1000;
    retryTarget.current = capabilityId;
    setClock(Date.now());
    loadErrorRef.current = failure;
    setLoadError(failure);
    return failure;
  }, [identity]);

  const captureOperationFailure = useCallback((error: unknown, capabilityId: string): void => {
    const failure = classifySkillLoadError(error);
    if (failure.kind === 'rate-limited' || failure.kind === 'auth' || failure.kind === 'forbidden') {
      autoRetryUsed.current = false;
      captureFailure(error, capabilityId);
    }
  }, [captureFailure]);

  const refreshSkills = useCallback(async function refresh(force = true, capabilityId?: string, recovery = false): Promise<void> {
    const now = Date.now();
    const currentError = loadErrorRef.current;
    const retryAt = currentError?.retryAt ?? 0;
    if (retryAt > now) return;
    if (!force && currentError && autoRetryUsed.current) return;
    if (inFlight.current) {
      if (inFlightRequest.current === generation.current && (requestTarget.current === undefined || requestTarget.current === capabilityId)) return inFlight.current;
      await inFlight.current;
      if (identity.active) return refresh(force, capabilityId, recovery);
      return;
    }
    if (force && !recovery) autoRetryUsed.current = false;

    const request = ++generation.current;
    loadErrorRef.current = null;
    setLoadError(null);
    setLoading(true);
    inFlightRequest.current = request;
    requestTarget.current = capabilityId;
    const requestPromise = Promise.resolve().then(async () => {
      try {
        if (generation.current !== request) return;
        const result = await window.electronAPI.listSkillLibrary({ mode: force ? 'manual' : 'auto', capabilityId });
        if (!identity.active || generation.current !== request) return;
        if (result.data) {
          setSkills(current => capabilityId
            ? current.filter(item => item.capability.id !== capabilityId).concat(result.data!.filter(item => item.capability.id === capabilityId))
            : result.data!);
          setSkillsWarning(result.skippedCount ? '部分技能数据异常，已跳过；其他技能仍可正常使用。' : null);
        }
        if (!result.success || !result.data) {
          const failure = classifySkillLoadError(result.error);
          if (failure.kind === 'rate-limited') failure.retryAt = result.retryAt ?? Date.now() + failure.retryAfterSeconds! * 1000;
          throw failure;
        }
        if (identity.active && generation.current === request) {
          autoRetryUsed.current = false;
          loadErrorRef.current = null;
          setLoadError(null);
        }
      } catch (error) {
        if (identity.active && generation.current === request) {
          captureFailure(error, capabilityId);
        }
      } finally {
        if (identity.active && generation.current === request) setLoading(false);
        if (inFlightRequest.current === request) {
          inFlight.current = null;
          inFlightRequest.current = null;
        }
      }
    });
    inFlight.current = requestPromise;
    return requestPromise;
  }, [identity, captureFailure]);

  useEffect(() => {
    setSkills([]);
    setStateScopeKey(scopeKey);
    setSkillsWarning(null);
    setLoading(true);
    loadErrorRef.current = null;
    setLoadError(null);
    inFlight.current = null;
    inFlightRequest.current = null;
    autoRetryUsed.current = false;
    retryTarget.current = undefined;
    return () => {
      generation.current += 1;
      inFlight.current = null;
      inFlightRequest.current = null;
    };
  }, [scopeKey]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const cacheGeneration = generation.current;
    void window.electronAPI.listSkillLibrary({ mode: 'cache' }).then(result => {
      if (!active || !identity.active || inFlight.current || cacheGeneration !== generation.current) return;
      if (result.success && result.data && (result.updatedAt !== undefined || result.data.length)) {
        setSkills(result.data);
        setLoading(false);
        setSkillsWarning(result.skippedCount ? '部分技能数据异常，已跳过；其他技能仍可正常使用。' : null);
      }
      if (result.retryAt && result.retryAt > Date.now()) {
        const failure = { ...classifySkillLoadError({ statusCode: 429, retryAfterMs: result.retryAt - Date.now() }), retryAt: result.retryAt };
        loadErrorRef.current = failure; setLoadError(failure); setClock(Date.now());
      }
    }).catch(() => undefined).finally(() => { if (active && identity.active) void refreshSkills(false); });
    const refresh = () => { if (!document.hidden) void refreshSkills(false); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [scopeKey, enabled, identity, refreshSkills]);

  useEffect(() => {
    if (loadError?.kind !== 'rate-limited' || !loadError.retryAt) return;
    const tick = () => {
      setClock(Date.now());
      if (enabled && !document.hidden && Date.now() >= loadError.retryAt! && !autoRetryUsed.current) {
        autoRetryUsed.current = true;
        void refreshSkills(true, retryTarget.current, true);
      }
    };
    const timer = window.setInterval(tick, 1000 + Math.floor(Math.random() * 500));
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [loadError, enabled, refreshSkills]);

  const skillsRetrySeconds = loadError?.kind === 'rate-limited' && loadError.retryAt
    ? Math.max(0, Math.ceil((loadError.retryAt - clock) / 1000))
    : null;
  const skillsError = loadError?.kind === 'rate-limited' && skillsRetrySeconds !== null
    ? skillsRetrySeconds > 0 ? formatSkillRateLimitMessage(skillsRetrySeconds) : '技能服务请求较多，现在可以重试。'
    : loadError?.message ?? null;

  const previewSkillSource = useCallback(async (capabilityId: string, versionId: string): Promise<string> => {
    const result = await window.electronAPI.previewLibrarySkill({ capabilityId, versionId });
    if (!identity.active) throw new Error('登录身份已变化，请重新打开技能。');
    if (!result.success || result.data === undefined) { captureOperationFailure(result.error, capabilityId); throw new Error(result.error?.message || '原文读取失败'); }
    return result.data;
  }, [identity, captureOperationFailure]);
  const rewriteSkillSource = useCallback(async (input: SkillRewriteInput): Promise<SkillRewriteResult> => {
    const result = await window.electronAPI.rewriteLibrarySkill(input);
    if (!identity.active) throw new Error('登录身份已变化，请重新打开技能。');
    if (!result.success || !result.data) throw new Error(result.error?.message || '改写失败，请重试');
    return result.data;
  }, [identity]);
  const cancelSkillRewrite = useCallback(async (requestId: string): Promise<void> => {
    const result = await window.electronAPI.cancelSkillRewrite({ requestId });
    if (!result.success) throw new Error(result.error?.message || '取消失败，请重试');
  }, []);
  const selectSkillVersion = useCallback(async (capabilityId: string, versionId: string): Promise<void> => {
    const result = await window.electronAPI.selectSkillVersion({ capabilityId, versionId });
    if (!identity.active) throw new Error('登录身份已变化，请重新打开技能。');
    if (!result.success) { captureOperationFailure(result.error, capabilityId); throw new Error(result.error?.message || '版本切换失败'); }
    generation.current += 1;
    setLoading(false);
    setSkills(current => current.map(item => item.capability.id === capabilityId ? result.data ?? { ...item, bindings: item.bindings.map(binding => ({ ...binding,
      selectionMode: versionId === FOLLOW_PLATFORM_SKILL_VERSION ? 'follow-platform' : 'personal',
      selectedVersionId: versionId === FOLLOW_PLATFORM_SKILL_VERSION ? binding.currentVersion?.id ?? null : versionId })) } : item));
  }, [identity, captureOperationFailure]);
  const saveSkillSource = useCallback(async (request: PersonalSkillVersionRequest, idempotencyKey: string): Promise<SaveSkillResult> => {
    const result = await window.electronAPI.savePersonalSkill({ request, idempotencyKey });
    if (!identity.active) throw new Error('登录身份已变化，请重新打开技能。');
    if (!result.success || !result.data) { captureOperationFailure(result.error, request.capabilityId); throw new Error(result.error?.message || '保存失败，原文未丢失，请重试'); }
    const saved = result.data;
    generation.current += 1;
    setLoading(false);
    // The durable save succeeded; a failed metadata refresh must not hide the new version.
    setSkills(current => current.map(item => item.capability.id !== request.capabilityId ? item : saved.item ?? {
      ...item,
      versions: saved.version ? [...item.versions.filter(version => version.id !== saved.version!.id), saved.version] : item.versions,
      usableVersionIds: [...new Set([...item.usableVersionIds, idempotencyKey])],
      localVersions: [...item.localVersions.filter(local => local.idempotencyKey !== idempotencyKey), {
        request, idempotencyKey,
        createdAt: item.localVersions.find(local => local.idempotencyKey === idempotencyKey)?.createdAt ?? new Date().toISOString(),
        ...(saved.version ? { uploadedVersion: saved.version } : {}),
      }],
    }));
    return saved;
  }, [identity, captureOperationFailure]);
  const retrySkillUpload = useCallback(async (capabilityId: string, idempotencyKey: string): Promise<SaveSkillResult> => {
    const result = await window.electronAPI.retryPersonalSkillUpload({ capabilityId, idempotencyKey });
    if (!identity.active) throw new Error('登录身份已变化，请重新打开技能。');
    if (!result.success || !result.data) { captureOperationFailure(result.error, capabilityId); throw new Error(result.error?.message || '上传失败'); }
    const saved = result.data;
    generation.current += 1;
    setLoading(false);
    if (saved.item || saved.version) setSkills(current => current.map(item => item.capability.id !== capabilityId ? item : saved.item ?? {
      ...item, versions: [...item.versions.filter(version => version.id !== saved.version!.id), saved.version!],
      localVersions: item.localVersions.map(local => local.idempotencyKey === idempotencyKey ? { ...local, uploadedVersion: saved.version } : local),
    }));
    return result.data;
  }, [identity, captureOperationFailure]);
  return {
    skills: stateScopeKey === scopeKey ? skills : [],
    skillsLoading: stateScopeKey === scopeKey ? skillsLoading : enabled,
    skillsWarning: stateScopeKey === scopeKey ? skillsWarning : null,
    skillsError: stateScopeKey === scopeKey ? skillsError : null,
    skillsErrorKind: (stateScopeKey === scopeKey ? loadError?.kind ?? null : null) as SkillLoadErrorKind | null,
    skillsRetrySeconds: stateScopeKey === scopeKey ? skillsRetrySeconds : null,
    refreshSkills,
    previewSkillSource,
    rewriteSkillSource,
    cancelSkillRewrite,
    selectSkillVersion,
    saveSkillSource,
    retrySkillUpload,
  };
}
export type SkillLibraryWorkspace = ReturnType<typeof useSkillLibrary>;
