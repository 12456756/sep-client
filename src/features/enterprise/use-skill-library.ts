import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersonalSkillVersionRequest } from '../../shared/platform-supplement-contracts';
import type { SaveSkillResult, SkillLibraryItem } from '../../shared/skill-library';
import { classifySkillLoadError, formatSkillRateLimitMessage, type SkillLoadError, type SkillLoadErrorKind } from './skill-load-state';

const FOCUS_REFRESH_COOLDOWN_MS = 30_000;

/** Server metadata and durable local versions only. No browser-side skill copies. */
export function useSkillLibrary(scopeKey: string) {
  const [skills, setSkills] = useState<SkillLibraryItem[]>([]);
  const [skillsLoading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<SkillLoadError | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const generation = useRef(0);
  const loadErrorRef = useRef<SkillLoadError | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const inFlightRequest = useRef<number | null>(null);
  const lastRefreshAt = useRef(0);

  const refreshSkills = useCallback(async (force = true): Promise<void> => {
    const now = Date.now();
    const currentError = loadErrorRef.current;
    const retryAt = currentError?.retryAfterSeconds && currentError.kind === 'rate-limited'
      ? lastRefreshAt.current + currentError.retryAfterSeconds * 1000
      : 0;
    if (retryAt > now) return;
    if (!force && now - lastRefreshAt.current < FOCUS_REFRESH_COOLDOWN_MS) return;
    if (inFlight.current) return inFlight.current;

    const request = ++generation.current;
    lastRefreshAt.current = now;
    setLoading(true);
    inFlightRequest.current = request;
    const requestPromise = Promise.resolve().then(async () => {
      try {
        const result = await window.electronAPI.listSkillLibrary();
        if (!result.success || !result.data) {
          throw classifySkillLoadError(result.error);
        }
        if (generation.current === request) {
          setSkills(result.data);
          loadErrorRef.current = null;
          setLoadError(null);
        }
      } catch (error) {
        if (generation.current === request) {
          const failure = error && typeof error === 'object' && 'kind' in error
            ? error as SkillLoadError
            : classifySkillLoadError(error);
          loadErrorRef.current = failure;
          setLoadError(failure);
        }
      } finally {
        if (generation.current === request) setLoading(false);
        if (inFlightRequest.current === request) {
          inFlight.current = null;
          inFlightRequest.current = null;
        }
      }
    });
    inFlight.current = requestPromise;
    return requestPromise;
  }, []);

  useEffect(() => {
    setSkills([]);
    loadErrorRef.current = null;
    setLoadError(null);
    inFlight.current = null;
    inFlightRequest.current = null;
    void refreshSkills();
    const refresh = () => { void refreshSkills(false); };
    window.addEventListener('focus', refresh);
    return () => {
      generation.current += 1;
      inFlight.current = null;
      inFlightRequest.current = null;
      window.removeEventListener('focus', refresh);
    };
  }, [scopeKey, refreshSkills]);

  useEffect(() => {
    if (loadError?.kind !== 'rate-limited' || !loadError.retryAfterSeconds) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [loadError]);

  const skillsRetrySeconds = loadError?.kind === 'rate-limited' && loadError.retryAfterSeconds
    ? Math.max(0, Math.ceil((lastRefreshAt.current + loadError.retryAfterSeconds * 1000 - clock) / 1000))
    : null;
  const skillsError = loadError?.kind === 'rate-limited' && skillsRetrySeconds !== null
    ? skillsRetrySeconds > 0 ? formatSkillRateLimitMessage(skillsRetrySeconds) : '技能服务请求较多，现在可以重试。'
    : loadError?.message ?? null;

  const previewSkillSource = useCallback(async (capabilityId: string, versionId: string): Promise<string> => {
    const result = await window.electronAPI.previewLibrarySkill({ capabilityId, versionId });
    if (!result.success || result.data === undefined) throw new Error(result.error?.message || '原文读取失败');
    return result.data;
  }, []);
  const selectSkillVersion = useCallback(async (capabilityId: string, versionId: string): Promise<void> => {
    const result = await window.electronAPI.selectSkillVersion({ capabilityId, versionId });
    if (!result.success) throw new Error(result.error?.message || '版本切换失败');
    setSkills(current => current.map(item => item.capability.id === capabilityId ? { ...item, bindings: item.bindings.map(binding => ({ ...binding, selectedVersionId: versionId })) } : item));
    await refreshSkills();
  }, [refreshSkills]);
  const saveSkillSource = useCallback(async (request: PersonalSkillVersionRequest, idempotencyKey: string): Promise<SaveSkillResult> => {
    const result = await window.electronAPI.savePersonalSkill({ request, idempotencyKey });
    if (!result.success || !result.data) throw new Error(result.error?.message || '保存失败，原文未丢失，请重试');
    const saved = result.data;
    // The durable save succeeded; a failed metadata refresh must not hide the new version.
    setSkills(current => current.map(item => item.capability.id !== request.capabilityId ? item : {
      ...item,
      versions: saved.version ? [...item.versions.filter(version => version.id !== saved.version!.id), saved.version] : item.versions,
      usableVersionIds: [...new Set([...item.usableVersionIds, idempotencyKey])],
      localVersions: [...item.localVersions.filter(local => local.idempotencyKey !== idempotencyKey), {
        request, idempotencyKey,
        createdAt: item.localVersions.find(local => local.idempotencyKey === idempotencyKey)?.createdAt ?? new Date().toISOString(),
        ...(saved.version ? { uploadedVersion: saved.version } : {}),
      }],
    }));
    await refreshSkills();
    return saved;
  }, [refreshSkills]);
  const retrySkillUpload = useCallback(async (capabilityId: string, idempotencyKey: string): Promise<SaveSkillResult> => {
    const result = await window.electronAPI.retryPersonalSkillUpload({ capabilityId, idempotencyKey });
    if (!result.success || !result.data) throw new Error(result.error?.message || '上传失败');
    const saved = result.data;
    if (saved.version) setSkills(current => current.map(item => item.capability.id !== capabilityId ? item : {
      ...item, versions: [...item.versions.filter(version => version.id !== saved.version!.id), saved.version!],
      localVersions: item.localVersions.map(local => local.idempotencyKey === idempotencyKey ? { ...local, uploadedVersion: saved.version } : local),
    }));
    await refreshSkills();
    return result.data;
  }, [refreshSkills]);
  return {
    skills,
    skillsLoading,
    skillsError,
    skillsErrorKind: (loadError?.kind ?? null) as SkillLoadErrorKind | null,
    skillsRetrySeconds,
    refreshSkills,
    previewSkillSource,
    selectSkillVersion,
    saveSkillSource,
    retrySkillUpload,
  };
}
export type SkillLibraryWorkspace = ReturnType<typeof useSkillLibrary>;
