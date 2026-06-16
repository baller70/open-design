import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import { useAnalytics } from '../analytics/provider';
import {
  trackDesignSystemsTemplateCardClick,
  trackDesignSystemsTopClick,
  trackDesignSystemStatusResult,
  trackPageView,
} from '../analytics/events';
import type {
  TrackingDesignSystemStatusAction,
  TrackingDesignSystemStatusValue,
} from '@open-design/contracts/analytics';
import { useI18n } from '../i18n';
import type { Locale } from '../i18n/types';
import {
  localizeDesignSystemCategory,
  localizeDesignSystemSummary,
} from '../i18n/content';
import {
  deleteDesignSystemDraft,
  fetchDesignSystemShowcase,
  updateDesignSystemDraft,
} from '../providers/registry';
import { buildSrcdoc } from '../runtime/srcdoc';
import { Icon } from './Icon';
import type { DesignSystemSummary, ProjectTemplate, Surface } from '../types';
import styles from './DesignSystemsTab.module.css';

interface Props {
  systems: DesignSystemSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPreview: (id: string) => void;
  onCreate?: () => void;
  onOpenSystem?: (id: string) => void;
  onSystemsRefresh?: () => Promise<void> | void;
  templates?: ProjectTemplate[];
}

const CATEGORY_ORDER = [
  'Starter',
  'AI & LLM',
  'Developer Tools',
  'Productivity & SaaS',
  'Backend & Data',
  'Design & Creative',
  'Fintech & Crypto',
  'E-Commerce & Retail',
  'Media & Consumer',
  'Automotive',
];

type SurfaceFilter = 'all' | Surface;
type PrimaryCollection = 'design-system' | 'template';
type DesignSystemCollection = 'mine' | 'official' | 'enterprise';
type TemplateCollection = 'mine' | 'enterprise';

const SURFACE_PILLS: { value: SurfaceFilter; labelKey: 'examples.modeAll' | 'ds.surfaceWeb' | 'ds.surfaceImage' | 'ds.surfaceVideo' | 'ds.surfaceAudio' }[] = [
  { value: 'all', labelKey: 'examples.modeAll' },
  { value: 'web', labelKey: 'ds.surfaceWeb' },
  { value: 'image', labelKey: 'ds.surfaceImage' },
  { value: 'video', labelKey: 'ds.surfaceVideo' },
  { value: 'audio', labelKey: 'ds.surfaceAudio' },
];

const SURFACE_LABEL_KEY: Record<Surface, 'ds.surfaceWeb' | 'ds.surfaceImage' | 'ds.surfaceVideo' | 'ds.surfaceAudio'> = {
  web: 'ds.surfaceWeb',
  image: 'ds.surfaceImage',
  video: 'ds.surfaceVideo',
  audio: 'ds.surfaceAudio',
};

function surfaceOf(system: DesignSystemSummary): Surface {
  return system.surface ?? 'web';
}

function isUserSystem(system: DesignSystemSummary): boolean {
  return system.source === 'user' || system.isEditable === true;
}

// `system.status` is the DesignSystemSummary status string from the
// daemon; map it onto the tracking enum used by
// `design_system_status_result.status_before|status_after`. The
// summary type today only carries `'draft' | 'published'`; the wider
// tracking enum keeps room for `ready`/`failed`/`archived` once those
// land server-side. Unknown values collapse to `'unknown'`.
function mapStatusToTracking(
  status: string | null | undefined,
): TrackingDesignSystemStatusValue {
  switch (status) {
    case 'draft':
    case 'published':
      return status;
    default:
      return 'unknown';
  }
}

function formatShortDate(value: number | string | undefined): string {
  if (!value) return 'just now';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

function systemMatchesQuery(
  locale: Locale,
  system: DesignSystemSummary,
  query: string,
): boolean {
  if (!query) return true;
  const summary = localizeDesignSystemSummary(locale, system).toLowerCase();
  const categoryLabel = localizeDesignSystemCategory(
    locale,
    system.category || 'Uncategorized',
  ).toLowerCase();
  return (
    system.title.toLowerCase().includes(query) ||
    system.summary.toLowerCase().includes(query) ||
    summary.includes(query) ||
    categoryLabel.includes(query)
  );
}

export function DesignSystemsTab({
  systems,
  selectedId,
  onSelect,
  onPreview,
  onCreate,
  onOpenSystem,
  onSystemsRefresh,
  templates = [],
}: Props) {
  const { locale, t } = useI18n();
  const analytics = useAnalytics();
  const designSystemsPageViewFiredRef = useRef(false);
  useEffect(() => {
    if (designSystemsPageViewFiredRef.current) return;
    designSystemsPageViewFiredRef.current = true;
    // v2 doc: the DS list page also carries `area` / `view_type` /
    // `entry_from` so it can stitch the cross-surface DS funnel.
    // `entry_from` is `unknown` here because the tab is reached
    // through the home nav rail; a router-aware entry mapper can
    // refine this later.
    trackPageView(analytics.track, {
      page_name: 'design_systems',
      area: 'design_system_list',
      view_type: 'page',
      entry_from: 'unknown',
      available_design_system_count: systems.length,
    });
  }, [analytics.track, systems.length]);
  const searchTrackedRef = useRef(false);
  const categoryTrackedRef = useRef(false);
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [primaryCollection, setPrimaryCollection] = useState<PrimaryCollection>('design-system');
  const [designSystemCollection, setDesignSystemCollection] = useState<DesignSystemCollection>('mine');
  const [templateCollection, setTemplateCollection] = useState<TemplateCollection>('mine');
  const [surfaceFilter, setSurfaceFilter] = useState<SurfaceFilter>('all');
  const [category, setCategory] = useState<string>('All');
  // The master-detail selection — which row renders in the right preview pane.
  // Distinct from `selectedId`, which is the global *default* design system.
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Cache fetched showcase HTML so the preview never re-flickers when the user
  // re-selects a row. null = "in flight"; undefined = "not yet requested".
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});

  const q = filter.trim().toLowerCase();

  const librarySystems = useMemo(
    () => systems.filter((system) => !isUserSystem(system)),
    [systems],
  );

  const userSystems = useMemo(
    () => systems.filter(isUserSystem),
    [systems],
  );

  const userSearched = useMemo(
    () => userSystems.filter((s) => systemMatchesQuery(locale, s, q)),
    [userSystems, locale, q],
  );

  const surfaceScoped = useMemo(
    () => surfaceFilter === 'all'
      ? librarySystems
      : librarySystems.filter((s) => surfaceOf(s) === surfaceFilter),
    [librarySystems, surfaceFilter],
  );

  // Total systems per surface, ignoring every active filter. Drives the
  // "this surface is now empty" fallback below — that guard must react to
  // the catalog itself, not to a transient style/search filter.
  const surfaceTotals = useMemo(() => {
    const counts: Record<SurfaceFilter, number> = { all: librarySystems.length, web: 0, image: 0, video: 0, audio: 0 };
    for (const s of librarySystems) counts[surfaceOf(s)]++;
    return counts;
  }, [librarySystems]);

  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const s of surfaceScoped) cats.add(s.category || 'Uncategorized');
    const ordered: string[] = [];
    for (const c of CATEGORY_ORDER) if (cats.has(c)) ordered.push(c);
    for (const c of [...cats].sort()) if (!ordered.includes(c)) ordered.push(c);
    return ['All', ...ordered];
  }, [surfaceScoped]);

  // Keep surfaceFilter and category in sync when systems changes dynamically.
  // If the currently selected surface has zero items, fall back to 'all'.
  // If the current category is no longer present in the filtered list, fall back to 'All'.
  useEffect(() => {
    if (surfaceFilter !== 'all' && surfaceTotals[surfaceFilter] === 0) {
      setSurfaceFilter('all');
      setCategory('All');
    } else if (category !== 'All' && !categories.includes(category)) {
      setCategory('All');
    }
  }, [systems, surfaceFilter, surfaceTotals, category, categories]);

  // Systems matching the active style category and search text, before the
  // surface filter is applied. Both the surface pill counts and the visible
  // list derive from this so a surface chip always reports its own result
  // set rather than the unfiltered catalog total.
  const queryScoped = useMemo(() => {
    return librarySystems.filter((s) => {
      if (category !== 'All' && (s.category || 'Uncategorized') !== category) return false;
      return systemMatchesQuery(locale, s, q);
    });
  }, [librarySystems, q, category, locale]);

  const surfaceCounts = useMemo(() => {
    const counts: Record<SurfaceFilter, number> = {
      all: queryScoped.length, web: 0, image: 0, video: 0, audio: 0,
    };
    for (const s of queryScoped) counts[surfaceOf(s)]++;
    return counts;
  }, [queryScoped]);

  const filtered = useMemo(
    () => surfaceFilter === 'all'
      ? queryScoped
      : queryScoped.filter((s) => surfaceOf(s) === surfaceFilter),
    [queryScoped, surfaceFilter],
  );

  const templatesSearched = useMemo(() => {
    if (!q) return templates;
    return templates.filter((tpl) =>
      tpl.name.toLowerCase().includes(q) ||
      (tpl.description ?? '').toLowerCase().includes(q),
    );
  }, [templates, q]);

  // The list backing the active scope. Design-system scopes carry summaries;
  // template scope is handled through `templatesSearched`.
  const activeSystems = useMemo<DesignSystemSummary[]>(() => {
    if (primaryCollection !== 'design-system') return [];
    if (designSystemCollection === 'mine') return userSearched;
    if (designSystemCollection === 'official') return filtered;
    return [];
  }, [primaryCollection, designSystemCollection, userSearched, filtered]);

  const activeIds = useMemo(() => {
    if (primaryCollection === 'design-system') return activeSystems.map((s) => s.id);
    if (primaryCollection === 'template' && templateCollection === 'mine') {
      return templatesSearched.map((tpl) => tpl.id);
    }
    return [];
  }, [primaryCollection, templateCollection, activeSystems, templatesSearched]);

  // Keep the previewed row valid as scopes / filters change: hold the current
  // pick when it still exists, otherwise fall back to the first row (mirrors
  // the Brand Kit master-detail). Empty scopes clear the selection.
  useEffect(() => {
    if (activeIds.length === 0) {
      setPreviewId(null);
      return;
    }
    setPreviewId((cur) => (cur && activeIds.includes(cur) ? cur : activeIds[0] ?? null));
  }, [activeIds]);

  const selectedSystem = useMemo(() => {
    if (primaryCollection !== 'design-system' || !previewId) return null;
    return activeSystems.find((s) => s.id === previewId) ?? null;
  }, [primaryCollection, previewId, activeSystems]);

  const selectedTemplate = useMemo(() => {
    if (primaryCollection !== 'template' || !previewId) return null;
    return templatesSearched.find((tpl) => tpl.id === previewId) ?? null;
  }, [primaryCollection, previewId, templatesSearched]);

  // Lazily fetch the showcase HTML for the previewed design system. Only one
  // iframe is ever mounted (the selected detail), so unlike the old card grid
  // there is no need for an IntersectionObserver gate.
  useEffect(() => {
    if (primaryCollection !== 'design-system' || !previewId) return;
    setThumbs((prev) => {
      if (prev[previewId] !== undefined) return prev;
      void fetchDesignSystemShowcase(previewId).then((html) => {
        setThumbs((p) => ({ ...p, [previewId]: html }));
      });
      return { ...prev, [previewId]: null };
    });
  }, [primaryCollection, previewId]);

  // Category metadata is authored in English; keep raw values in state for
  // filtering while localizing the visible labels for the current UI locale.
  const renderCategory = (c: string) => {
    if (c === 'All') return t('ds.categoryAll');
    if (c === 'Uncategorized') return t('ds.categoryUncategorized');
    return localizeDesignSystemCategory(locale, c);
  };

  async function refreshSystems() {
    await onSystemsRefresh?.();
  }

  async function togglePublished(system: DesignSystemSummary) {
    setBusyId(system.id);
    const startedAt = performance.now();
    const willPublish = system.status !== 'published';
    const action: TrackingDesignSystemStatusAction = willPublish
      ? 'publish'
      : 'unpublish';
    const statusBefore = mapStatusToTracking(system.status);
    const isDefaultBefore = system.id === selectedId;
    let succeeded = false;
    let errorCode: string | undefined;
    try {
      const updated = await updateDesignSystemDraft(system.id, {
        status: willPublish ? 'published' : 'draft',
      });
      succeeded = Boolean(updated);
      if (!succeeded) errorCode = 'DS_STATUS_UPDATE_RETURNED_NULL';
      await refreshSystems();
    } catch (err) {
      errorCode = err instanceof Error
        ? `DS_STATUS_UPDATE_THREW:${err.message.slice(0, 80)}`
        : 'DS_STATUS_UPDATE_THREW';
      throw err;
    } finally {
      setBusyId(null);
      trackDesignSystemStatusResult(analytics.track, {
        page_name: 'design_systems',
        area: 'design_system_status',
        action,
        result: succeeded ? 'success' : 'failed',
        design_system_id: system.id,
        status_before: statusBefore,
        status_after: succeeded
          ? willPublish
            ? 'published'
            : 'draft'
          : statusBefore,
        is_default_before: isDefaultBefore,
        is_default_after: isDefaultBefore,
        error_code: errorCode,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  }

  async function deleteSystem(system: DesignSystemSummary) {
    const ok = window.confirm(`Delete "${system.title}"? This removes the draft design system from this device.`);
    if (!ok) {
      trackDesignSystemStatusResult(analytics.track, {
        page_name: 'design_systems',
        area: 'design_system_status',
        action: 'delete',
        result: 'cancelled',
        design_system_id: system.id,
        status_before: mapStatusToTracking(system.status),
        status_after: mapStatusToTracking(system.status),
        is_default_before: system.id === selectedId,
        is_default_after: system.id === selectedId,
        duration_ms: 0,
      });
      return;
    }
    setBusyId(system.id);
    const startedAt = performance.now();
    const statusBefore = mapStatusToTracking(system.status);
    const wasDefault = system.id === selectedId;
    let succeeded = false;
    let errorCode: string | undefined;
    try {
      const deleted = await deleteDesignSystemDraft(system.id);
      succeeded = Boolean(deleted);
      if (!succeeded) errorCode = 'DS_DELETE_RETURNED_FALSE';
      if (succeeded && selectedId === system.id) {
        const fallback = systems.find((candidate) =>
          candidate.id !== system.id && isUserSystem(candidate),
        );
        if (fallback) onSelect(fallback.id);
      }
      await refreshSystems();
    } catch (err) {
      errorCode = err instanceof Error
        ? `DS_DELETE_THREW:${err.message.slice(0, 80)}`
        : 'DS_DELETE_THREW';
      throw err;
    } finally {
      setBusyId(null);
      trackDesignSystemStatusResult(analytics.track, {
        page_name: 'design_systems',
        area: 'design_system_status',
        action: 'delete',
        result: succeeded ? 'success' : 'failed',
        design_system_id: system.id,
        status_before: statusBefore,
        status_after: succeeded ? 'deleted' : statusBefore,
        is_default_before: wasDefault,
        // After a successful delete the row is gone; if it was the
        // default the consumer remapped to a fallback above, so this
        // DS is no longer the default either way.
        is_default_after: false,
        error_code: errorCode,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  }

  function handleMakeDefaultClick(system: DesignSystemSummary): void {
    const wasDefault = system.id === selectedId;
    const statusBefore = mapStatusToTracking(system.status);
    onSelect(system.id);
    trackDesignSystemStatusResult(analytics.track, {
      page_name: 'design_systems',
      area: 'design_system_status',
      action: wasDefault ? 'unset_default' : 'set_default',
      result: 'success',
      design_system_id: system.id,
      status_before: statusBefore,
      status_after: statusBefore,
      is_default_before: wasDefault,
      is_default_after: !wasDefault,
      duration_ms: 0,
    });
  }

  function trackCardClick(system: DesignSystemSummary): void {
    trackDesignSystemsTemplateCardClick(analytics.track, {
      page_name: 'design_systems',
      area: 'templates_card',
      element: 'templates_card',
      templates_id: system.id,
      templates_type: system.source ?? 'library',
    });
  }

  function handleSelectSystem(system: DesignSystemSummary): void {
    setPreviewId(system.id);
    trackCardClick(system);
  }

  function handlePreviewSystem(system: DesignSystemSummary): void {
    trackCardClick(system);
    onPreview(system.id);
  }

  const activeScope = primaryCollection === 'design-system'
    ? designSystemCollection
    : templateCollection;

  const scopeTabs = primaryCollection === 'design-system'
    ? [
        { value: 'mine' as const, label: t('dsManager.yourSystems') },
        { value: 'official' as const, label: t('dsManager.officialPresets') },
        { value: 'enterprise' as const, label: t('dsManager.enterprise') },
      ]
    : [
        { value: 'mine' as const, label: t('dsManager.yourTemplates') },
        { value: 'enterprise' as const, label: t('dsManager.enterprise') },
      ];

  function setScope(value: DesignSystemCollection | TemplateCollection): void {
    if (primaryCollection === 'design-system') {
      setDesignSystemCollection(value as DesignSystemCollection);
    } else {
      setTemplateCollection(value as TemplateCollection);
    }
  }

  const showPresetFilters = primaryCollection === 'design-system' && designSystemCollection === 'official';

  return (
    <div className={styles.root} data-testid="design-systems-tab">
      <aside className={styles.sidebar}>
        <div className={styles.segmented} role="tablist" aria-label={t('dsManager.areaAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={primaryCollection === 'design-system'}
            className={`${styles.segmentedBtn} ${primaryCollection === 'design-system' ? styles.active : ''}`}
            onClick={() => setPrimaryCollection('design-system')}
          >
            {t('dsManager.tabDesignSystem')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={primaryCollection === 'template'}
            className={`${styles.segmentedBtn} ${primaryCollection === 'template' ? styles.active : ''}`}
            onClick={() => setPrimaryCollection('template')}
          >
            {t('dsManager.tabTemplate')}
          </button>
        </div>

        {primaryCollection === 'design-system' && onCreate ? (
          <Button
            variant="primary"
            className={styles.newBtn}
            onClick={onCreate}
            data-testid="design-systems-create"
          >
            <Icon name="plus" />
            {t('dsManager.createAction')}
          </Button>
        ) : null}

        <div className={styles.searchWrap}>
          <SearchGlyph className={styles.searchIcon} />
          <input
            type="search"
            data-testid="design-systems-search"
            className={styles.search}
            placeholder={t('ds.searchPlaceholder')}
            value={filter}
            onFocus={() => {
              if (searchTrackedRef.current) return;
              searchTrackedRef.current = true;
              trackDesignSystemsTopClick(analytics.track, {
                page_name: 'design_systems',
                area: 'design_systems',
                element: 'search_input',
              });
            }}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <div
          className={styles.scopes}
          role="tablist"
          aria-label={primaryCollection === 'design-system'
            ? t('dsManager.sourceAria')
            : t('dsManager.templateSourceAria')}
        >
          {scopeTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={activeScope === tab.value}
              className={`${styles.scopeChip} ${activeScope === tab.value ? styles.scopeChipActive : ''}`}
              onClick={() => setScope(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {showPresetFilters ? (
          <div className={styles.presetFilters}>
            <div className={styles.surfaceRow} role="tablist" aria-label={t('ds.surfaceLabel')}>
              {/* Hide chips with no items in the active style/search filter, but
                  always keep "all" and the currently selected surface — otherwise a
                  transient search could remove the active chip and leave the list
                  filtered with no chip showing aria-selected. */}
              {SURFACE_PILLS.filter(
                (p) => p.value === surfaceFilter || p.value === 'all' || surfaceCounts[p.value] > 0,
              ).map((p) => (
                <button
                  key={p.value}
                  type="button"
                  role="tab"
                  aria-selected={surfaceFilter === p.value}
                  data-testid={`design-systems-surface-${p.value}`}
                  className={`${styles.surfacePill} ${surfaceFilter === p.value ? styles.surfacePillActive : ''}`}
                  onClick={() => {
                    trackDesignSystemsTopClick(analytics.track, {
                      page_name: 'design_systems',
                      area: 'design_systems',
                      element: 'filter_chip',
                      filter_name: p.value,
                    });
                    setSurfaceFilter(p.value);
                  }}
                >
                  {t(p.labelKey)}
                  <span className={`filter-pill-count ${styles.surfaceCount}`}>{surfaceCounts[p.value]}</span>
                </button>
              ))}
            </div>
            <select
              data-testid="design-systems-category-select"
              className={styles.categorySelect}
              value={category}
              onFocus={() => {
                if (categoryTrackedRef.current) return;
                categoryTrackedRef.current = true;
                trackDesignSystemsTopClick(analytics.track, {
                  page_name: 'design_systems',
                  area: 'design_systems',
                  element: 'search_dropdown',
                });
              }}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {renderCategory(c)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className={styles.list} data-testid="design-systems-list">
          {renderSidebarList()}
        </div>
      </aside>

      <section className={styles.preview} data-testid="design-systems-preview">
        {renderPreview()}
      </section>
    </div>
  );

  function renderSidebarList() {
    if (primaryCollection === 'design-system') {
      if (designSystemCollection === 'enterprise') {
        return (
          <div className={styles.sidebarEmpty}>
            <p className={styles.sidebarEmptyText}>{t('dsManager.enterpriseDsBody')}</p>
          </div>
        );
      }
      if (activeSystems.length === 0) {
        if (designSystemCollection === 'official') {
          return (
            <div className={styles.sidebarEmpty} data-testid="design-systems-empty">
              <p className={styles.sidebarEmptyText}>{t('ds.emptyNoMatch')}</p>
            </div>
          );
        }
        return (
          <div className={styles.sidebarEmpty}>
            <p className={styles.sidebarEmptyText}>{t('dsManager.emptyMine')}</p>
          </div>
        );
      }
      return activeSystems.map((system) => (
        <SystemRow
          key={system.id}
          system={system}
          active={system.id === previewId}
          isDefault={system.id === selectedId}
          categoryLabel={localizeDesignSystemCategory(locale, system.category || 'Uncategorized')}
          statusLabel={(system.status ?? 'draft') === 'published' ? t('dsManager.statusPublished') : t('dsManager.statusDraft')}
          onSelect={() => handleSelectSystem(system)}
        />
      ));
    }

    // Template collection
    if (templateCollection === 'enterprise') {
      return (
        <div className={styles.sidebarEmpty}>
          <p className={styles.sidebarEmptyText}>{t('dsManager.enterpriseTplBody')}</p>
        </div>
      );
    }
    if (templatesSearched.length === 0) {
      return (
        <div className={styles.sidebarEmpty}>
          <p className={styles.sidebarEmptyText}>{t('dsManager.emptyTemplates')}</p>
        </div>
      );
    }
    return templatesSearched.map((tpl) => (
      <button
        key={tpl.id}
        type="button"
        className={`${styles.item} ${tpl.id === previewId ? styles.itemActive : ''}`}
        aria-pressed={tpl.id === previewId}
        onClick={() => setPreviewId(tpl.id)}
      >
        <span className={styles.itemThumb}>
          <span className={styles.itemThumbFallback}>{(tpl.name || '?').charAt(0).toUpperCase()}</span>
        </span>
        <span className={styles.itemMeta}>
          <span className={styles.itemNameRow}>
            <span className={styles.itemName}>{tpl.name}</span>
          </span>
          <span className={styles.itemSub}>{formatShortDate(tpl.createdAt)}</span>
        </span>
      </button>
    ));
  }

  function renderPreview() {
    if (activeScope === 'enterprise') {
      return (
        <ComingSoon
          title={primaryCollection === 'design-system' ? t('dsManager.enterpriseDsTitle') : t('dsManager.enterpriseTplTitle')}
          body={primaryCollection === 'design-system' ? t('dsManager.enterpriseDsBody') : t('dsManager.enterpriseTplBody')}
          comingSoonLabel={t('dsManager.comingSoonBadge')}
        />
      );
    }

    if (selectedSystem) {
      return (
        <DesignSystemDetail
          system={selectedSystem}
          isDefault={selectedSystem.id === selectedId}
          showcaseHtml={thumbs[selectedSystem.id]}
          busy={busyId === selectedSystem.id}
          categoryLabel={localizeDesignSystemCategory(locale, selectedSystem.category || 'Uncategorized')}
          surfaceLabel={t(SURFACE_LABEL_KEY[surfaceOf(selectedSystem)])}
          summary={localizeDesignSystemSummary(locale, selectedSystem)}
          t={t}
          onEdit={onOpenSystem}
          onMakeDefault={handleMakeDefaultClick}
          onTogglePublished={togglePublished}
          onDelete={deleteSystem}
          onPreviewFull={handlePreviewSystem}
        />
      );
    }

    if (selectedTemplate) {
      return (
        <div className={styles.detail}>
          <div className={styles.head}>
            <div className={styles.headText}>
              <div className={styles.titleRow}>
                <h2 className={styles.title}>{selectedTemplate.name}</h2>
              </div>
              <div className={styles.metaRow}>{formatShortDate(selectedTemplate.createdAt)}</div>
            </div>
          </div>
          <p className={styles.summary}>
            {selectedTemplate.description?.trim() || t('dsManager.templateDescFallback')}
          </p>
        </div>
      );
    }

    // Empty scope — invite the relevant next action.
    const emptyText = primaryCollection === 'template'
      ? t('dsManager.emptyTemplates')
      : designSystemCollection === 'official'
        ? t('ds.emptyNoMatch')
        : t('dsManager.emptyMine');
    const emptyTitle = primaryCollection === 'design-system' && designSystemCollection === 'mine'
      ? t('dsManager.createTitle')
      : null;
    return (
      <div className={styles.previewEmpty}>
        <span className={styles.previewEmptyMark} aria-hidden>
          <SparkGlyph />
        </span>
        {emptyTitle ? <p className={styles.previewEmptyTitle}>{emptyTitle}</p> : null}
        <p className={styles.previewEmptyText}>{emptyText}</p>
      </div>
    );
  }
}

interface SystemRowProps {
  system: DesignSystemSummary;
  active: boolean;
  isDefault: boolean;
  categoryLabel: string;
  statusLabel: string;
  onSelect: () => void;
}

function SystemRow({ system, active, isDefault, categoryLabel, statusLabel, onSelect }: SystemRowProps) {
  const { t } = useI18n();
  const swatches = system.swatches ?? [];
  const status = system.status ?? 'draft';
  const isUser = isUserSystem(system);
  return (
    <button
      type="button"
      data-testid={`design-system-card-${system.id}`}
      className={`${styles.item} ${active ? styles.itemActive : ''}`}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className={styles.itemThumb}>
        {swatches.length > 0 ? (
          <span className={styles.itemSwatches} aria-hidden>
            {swatches.slice(0, 4).map((c, i) => (
              <span key={i} style={{ background: c }} />
            ))}
          </span>
        ) : (
          <span className={styles.itemThumbFallback} aria-hidden>
            {(system.title || '?').charAt(0).toUpperCase()}
          </span>
        )}
      </span>
      <span className={styles.itemMeta}>
        <span className={styles.itemNameRow}>
          <span className={styles.itemName}>{system.title}</span>
          {isDefault ? <span className={styles.badgeDefault}>{t('dsManager.badgeDefault')}</span> : null}
        </span>
        <span className={styles.itemSub}>{categoryLabel}</span>
      </span>
      {isUser ? (
        <span
          className={`${styles.statusDot} ${status === 'published' ? styles.statusDotPublished : styles.statusDotDraft}`}
          title={statusLabel}
          aria-label={statusLabel}
        />
      ) : null}
    </button>
  );
}

interface DetailProps {
  system: DesignSystemSummary;
  isDefault: boolean;
  showcaseHtml: string | null | undefined;
  busy: boolean;
  categoryLabel: string;
  surfaceLabel: string;
  summary: string;
  t: ReturnType<typeof useI18n>['t'];
  onEdit?: (id: string) => void;
  onMakeDefault: (system: DesignSystemSummary) => void;
  onTogglePublished: (system: DesignSystemSummary) => void | Promise<void>;
  onDelete: (system: DesignSystemSummary) => void | Promise<void>;
  onPreviewFull: (system: DesignSystemSummary) => void;
}

function DesignSystemDetail({
  system,
  isDefault,
  showcaseHtml,
  busy,
  categoryLabel,
  surfaceLabel,
  summary,
  t,
  onEdit,
  onMakeDefault,
  onTogglePublished,
  onDelete,
  onPreviewFull,
}: DetailProps) {
  const isUser = isUserSystem(system);
  const status = system.status ?? 'draft';
  const published = status === 'published';
  // A built-in preset can always be picked as the global default; a user
  // system must be published first (mirrors the old "Make default" gate).
  const canBeDefault = !isUser || published;
  const swatches = system.swatches ?? [];

  return (
    <div className={styles.detail} data-testid={`design-system-detail-${system.id}`}>
      <div className={styles.cover}>
        {showcaseHtml ? (
          <iframe
            className={styles.coverFrame}
            title={`${system.title} preview`}
            sandbox="allow-scripts"
            srcDoc={buildSrcdoc(showcaseHtml)}
            tabIndex={-1}
            aria-hidden
          />
        ) : swatches.length > 0 ? (
          <div className={styles.coverSwatches} aria-hidden>
            {swatches.map((c, i) => (
              <span key={i} style={{ background: c }} />
            ))}
          </div>
        ) : (
          <div className={styles.coverFallback}>{system.title}</div>
        )}
      </div>

      <div className={styles.head}>
        <div className={styles.headText}>
          <div className={styles.titleRow}>
            <h2 className={styles.title}>{system.title}</h2>
            {isDefault ? <span className={styles.badgeDefault}>{t('dsManager.badgeDefault')}</span> : null}
          </div>
          <div className={styles.metaRow}>
            <span>{categoryLabel}</span>
            <span className={styles.metaDot}>·</span>
            <span>{surfaceLabel}</span>
            {isUser ? (
              <>
                <span className={styles.metaDot}>·</span>
                <span className={`${styles.statusBadge} ${published ? styles.statusBadgePublished : ''}`}>
                  {published ? t('dsManager.statusPublished') : t('dsManager.statusDraft')}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {summary ? <p className={styles.summary}>{summary}</p> : null}

      {swatches.length > 0 ? (
        <div className={styles.swatchStrip}>
          {swatches.map((c, i) => (
            <span key={i} className={styles.swatchChip}>
              <span className={styles.swatchDot} style={{ background: c }} />
              <span className={styles.swatchHex}>{c}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className={styles.actions}>
        {isUser && onEdit ? (
          <Button onClick={() => onEdit(system.id)} disabled={busy}>
            {t('dsManager.edit')}
          </Button>
        ) : null}
        {canBeDefault && !isDefault ? (
          <Button
            variant="primary"
            data-testid={`design-system-select-${system.id}`}
            onClick={() => onMakeDefault(system)}
            disabled={busy}
          >
            {t('dsManager.makeDefault')}
          </Button>
        ) : null}
        <Button
          data-testid={`design-system-preview-${system.id}`}
          onClick={() => onPreviewFull(system)}
          disabled={busy}
        >
          <Icon name="external-link" />
          {t('ds.preview')}
        </Button>
        <span className={styles.actionsSpacer} />
        {isUser ? (
          <button
            type="button"
            className={`${styles.statusToggle} ${published ? styles.statusToggleOn : ''}`}
            aria-pressed={published}
            onClick={() => void onTogglePublished(system)}
            disabled={busy}
          >
            <span>{published ? t('dsManager.statusPublished') : t('dsManager.statusDraft')}</span>
            <span className={styles.statusToggleTrack} aria-hidden />
          </button>
        ) : null}
        {isUser ? (
          <Button
            size="icon"
            className={styles.dangerBtn}
            aria-label={t('dsManager.deleteSystemAria', { title: system.title })}
            onClick={() => void onDelete(system)}
            disabled={busy}
          >
            <Icon name="close" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ComingSoon({
  title,
  body,
  comingSoonLabel,
}: {
  title: string;
  body: string;
  comingSoonLabel: string;
}) {
  return (
    <div className={styles.previewEmpty}>
      <span className={styles.comingSoonBadge}>{comingSoonLabel}</span>
      <p className={styles.previewEmptyTitle}>{title}</p>
      <p className={styles.previewEmptyText}>{body}</p>
    </div>
  );
}

function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SparkGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden>
      <path
        d="M12 3l1.8 4.9L18.7 9.7 13.8 11.5 12 16.4 10.2 11.5 5.3 9.7l4.9-1.8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
