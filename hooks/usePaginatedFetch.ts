"use client"

import { useCallback, useEffect, useRef, useState } from "react"

// Arbitrary filter → query-param map. Each non-empty value is sent as a query
// param named after its key (e.g. { event, customer, items } for orders;
// { name, store, type, country } for products).
type Filters = Record<string, string>
type SortConfig = { key: string; direction: "asc" | "desc" } | null

export type PageData = {
  rows: unknown[]
  totalCount: number
  totalPages: number
  page: number
  filteredSum: number | null
  filteredValue?: number | null
}

type FetchState = {
  loading: boolean
  error: string
  refreshError: string
}

const INITIAL_FETCH_STATE: FetchState = { loading: true, error: "", refreshError: "" }

export function usePaginatedFetch(opts: {
  endpoint: string
  pageSize: number
  page: number
  search: string
  filters: Filters
  sort: SortConfig
  onData: (data: PageData) => void
}) {
  const { endpoint, pageSize, page, search, filters, sort, onData } = opts
  const [fetchState, setFetchState] = useState<FetchState>(INITIAL_FETCH_STATE)
  const onDataRef = useRef(onData)
  onDataRef.current = onData

  // Shape = the part of the request that determines totalCount (search +
  // filters + sort + pageSize). Server returns totalCount = -1 when we passed
  // skipCount=true; we splice the cached count back in before invoking onData,
  // so the consumer never sees the sentinel.
  const lastFetchedShapeRef = useRef<string | null>(null)
  const lastTotalCountRef = useRef<number>(0)
  const lastTotalPagesRef = useRef<number>(1)
  const lastFilteredSumRef = useRef<number | null>(null)
  const lastFilteredValueRef = useRef<number | null>(null)

  const fetchPage = useCallback(async (
    p: number,
    s: string,
    f: Filters,
    so: SortConfig,
    isRefresh = false,
  ) => {
    setFetchState((prev) => ({ ...prev, loading: !isRefresh, refreshError: "" }))
    const params = new URLSearchParams()
    params.set("page", String(p))
    params.set("pageSize", String(pageSize))
    if (s) params.set("search", s)
    for (const [key, value] of Object.entries(f)) {
      if (value) params.set(key, value)
    }
    if (so) {
      params.set("sortKey", so.key)
      params.set("sortDir", so.direction)
    } else {
      params.set("newestFirst", "true")
    }

    // The shape excludes the page number — only page is allowed to change
    // while still skipping the count. Refresh always recounts (data may have
    // changed under us) so it bypasses the cache via the isRefresh check.
    const shape = JSON.stringify({ pageSize, s, f, so })
    const canSkipCount = !isRefresh && lastFetchedShapeRef.current === shape
    if (canSkipCount) params.set("skipCount", "true")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch(`${endpoint}?${params}`, { signal: controller.signal, cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load rows")
      // Server sends -1 when it skipped the count; substitute the cached value
      // so the DataGrid keeps showing the correct total.
      let totalCount = Number(data.totalCount)
      let totalPages = Number(data.totalPages)
      if (totalCount < 0) {
        totalCount = lastTotalCountRef.current
        totalPages = lastTotalPagesRef.current
      } else {
        lastTotalCountRef.current = totalCount
        lastTotalPagesRef.current = totalPages
      }
      // filteredSum is null when the server skipped it (skipCount=true); reuse
      // the cached value since the sum doesn't change across pages of the same filter.
      let filteredSum: number | null = data.filteredSum as number | null | undefined ?? null
      if (filteredSum === null) {
        filteredSum = lastFilteredSumRef.current
      } else {
        lastFilteredSumRef.current = filteredSum
      }
      // Same skip-count fallback as filteredSum — the server only computes
      // filteredValue alongside the count, so it comes back null whenever
      // skipCount was set.
      let filteredValue: number | null = data.filteredValue as number | null | undefined ?? null
      if (filteredValue === null) {
        filteredValue = lastFilteredValueRef.current
      } else {
        lastFilteredValueRef.current = filteredValue
      }
      lastFetchedShapeRef.current = shape
      onDataRef.current({ ...data, totalCount, totalPages, filteredSum, filteredValue })
      setFetchState({ loading: false, error: "", refreshError: "" })
    } catch (err) {
      const msg =
        err instanceof Error && err.name === "AbortError"
          ? "Request timed out — please retry"
          : err instanceof Error ? err.message : "Failed to load rows"
      if (isRefresh) setFetchState((prev) => ({ ...prev, loading: false, refreshError: msg }))
      else setFetchState({ loading: false, error: msg, refreshError: "" })
    } finally {
      clearTimeout(timer)
    }
  }, [endpoint, pageSize])

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRender = useRef(true)
  const prevSearch = useRef(search)
  const prevPage = useRef(page)
  const prevFilters = useRef(filters)
  const prevSort = useRef(sort)

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      fetchPage(page, search, filters, sort)
      return
    }

    const searchChanged = prevSearch.current !== search
    const otherChanged = prevPage.current !== page || prevFilters.current !== filters || prevSort.current !== sort

    prevSearch.current = search
    prevPage.current = page
    prevFilters.current = filters
    prevSort.current = sort

    if (searchChanged && !otherChanged) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      searchTimerRef.current = setTimeout(() => {
        fetchPage(1, search, filters, sort)
      }, 300)
      return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
    }

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    fetchPage(searchChanged ? 1 : page, search, filters, sort)
  }, [page, search, filters, sort, fetchPage])

  const refresh = useCallback(() => {
    fetchPage(page, search, filters, sort, true)
  }, [fetchPage, page, search, filters, sort])

  return { fetchState, fetchPage, refresh }
}
