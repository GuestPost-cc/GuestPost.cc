"use client"

import {
  type Category,
  type WebsiteImportBatchResponse,
  type WebsiteImportRowStatus,
} from "@guestpost/api-client"
import {
  LISTING_LINK_TYPES,
  LISTING_LINK_VALIDITIES,
  MARKETPLACE_LANGUAGES,
} from "@guestpost/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  CheckCircle2,
  FileDown,
  Loader2,
  Upload,
} from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  AdminNotice,
  AdminPage,
  AdminPageHeader,
} from "../../../../components/admin-workspace"
import { api, getApiUrl } from "../../../../lib/api"
import { ForbiddenPage, useRequireRole } from "../../../../lib/use-require-role"

const ROW_BADGE: Record<
  WebsiteImportRowStatus,
  "default" | "secondary" | "destructive" | "warning" | "success"
> = {
  READY: "success",
  WARNING: "warning",
  ERROR: "destructive",
  CREATED: "success",
  SKIPPED: "secondary",
  FAILED: "destructive",
}

const SERVICE_TYPES = [
  "GUEST_POST",
  "NICHE_EDIT",
  "EDITORIAL_LINK",
  "OUTREACH_LINK",
  "LOCAL_CITATION",
  "FOUNDATION_LINK",
  "BLOG_ARTICLE",
  "SEO_CONTENT",
] as const

const COLUMN_GUIDANCE = [
  {
    name: "website_url",
    requirement: "Required",
    accepted:
      "Public root URL using http:// or https://. No path, query, login, custom port, localhost, or IP address.",
    behavior: "An invalid or duplicate domain skips the entire row.",
  },
  {
    name: "website_name",
    requirement: "Optional",
    accepted:
      "Up to 100 characters; single line; no HTML or control characters.",
    behavior: "Invalid value is skipped.",
  },
  {
    name: "listing_title",
    requirement: "Optional",
    accepted: "3–200 descriptive characters; must not be a URL or domain.",
    behavior: "Blank or invalid value is replaced with a derived draft title.",
  },
  {
    name: "description",
    requirement: "Optional",
    accepted: "20–500 characters; no HTML or control characters.",
    behavior: "Invalid value is skipped; publisher completes it before review.",
  },
  {
    name: "country",
    requirement: "Optional",
    accepted: "Country name, up to 100 characters; single line; no HTML.",
    behavior: "Invalid value is skipped.",
  },
  {
    name: "primary_language",
    requirement: "Optional",
    accepted: "One exact supported language value shown below; case-sensitive.",
    behavior: "Unsupported value is skipped.",
  },
  {
    name: "category_slugs",
    requirement: "Optional",
    accepted:
      "Up to 7 active category slugs shown below, separated with | — for example business|technology-gadgets.",
    behavior: "Unknown, duplicate, or excess slugs are skipped individually.",
  },
  ...[
    "sports_gaming_allowed",
    "pharmacy_allowed",
    "crypto_allowed",
    "google_news",
    "marked_sponsored",
    "foreign_language_allowed",
  ].map((name) => ({
    name,
    requirement: "Optional",
    accepted: "true, false, or blank — use lowercase.",
    behavior: "Unsupported value is skipped.",
  })),
  {
    name: "backlink_count",
    requirement: "Optional",
    accepted: "1, 2, 3, or blank.",
    behavior: "Out-of-range or non-integer value is skipped.",
  },
  {
    name: "link_type",
    requirement: "Optional",
    accepted: LISTING_LINK_TYPES.join(", "),
    behavior: "Unsupported value is skipped.",
  },
  {
    name: "link_validity",
    requirement: "Optional",
    accepted: LISTING_LINK_VALIDITIES.join(", "),
    behavior: "Unsupported value is skipped.",
  },
  {
    name: "ahrefs_organic_traffic",
    requirement: "Optional pair",
    accepted: "Whole number from 0 to 2,147,483,647; no separators.",
    behavior: "Value and Ahrefs date are both skipped unless both are valid.",
  },
  {
    name: "ahrefs_traffic_as_of",
    requirement: "Optional pair",
    accepted: "Real, non-future date in YYYY-MM-DD format.",
    behavior: "Values older than 90 days import as stale with a warning.",
  },
  {
    name: "moz_domain_authority",
    requirement: "Optional pair",
    accepted: "Whole number from 0 to 100.",
    behavior: "Value and Moz date are both skipped unless both are valid.",
  },
  {
    name: "moz_da_as_of",
    requirement: "Optional pair",
    accepted: "Real, non-future date in YYYY-MM-DD format.",
    behavior: "Values older than 90 days import as stale with a warning.",
  },
  {
    name: "service_type",
    requirement: "Optional group",
    accepted: SERVICE_TYPES.join(", "),
    behavior: "Invalid required service values skip the whole initial service.",
  },
  {
    name: "service_price",
    requirement: "Required with service",
    accepted:
      "Decimal number greater than 0 and no more than 1,000,000, with at most 2 decimal places; no symbol.",
    behavior: "Invalid value skips the whole initial service.",
  },
  {
    name: "currency",
    requirement: "Required with service",
    accepted: "USD, EUR, or GBP.",
    behavior: "Unsupported value skips the whole initial service.",
  },
  {
    name: "turnaround_days",
    requirement: "Required with service",
    accepted: "Whole number from 1 to 365.",
    behavior: "Invalid value skips the whole initial service.",
  },
  {
    name: "revision_rounds",
    requirement: "Optional with service",
    accepted: "Whole number from 0 to 20; blank or invalid defaults to 2.",
    behavior: "Invalid value is skipped and the default is used.",
  },
  {
    name: "warranty_days",
    requirement: "Optional with service",
    accepted: "Whole number from 0 to 3,650, or blank.",
    behavior: "Invalid value is skipped without discarding a valid service.",
  },
] as const

export default function PublisherWebsiteImportPage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Super Admin" />
  return <PublisherWebsiteImport />
}

function PublisherWebsiteImport() {
  const queryClient = useQueryClient()
  const [publisherSearch, setPublisherSearch] = useState("")
  const [publisherId, setPublisherId] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [batch, setBatch] = useState<WebsiteImportBatchResponse | null>(null)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [forceDialog, setForceDialog] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")
  const [expiresInDays, setExpiresInDays] = useState("30")

  const publishersQ = useQuery({
    queryKey: ["admin", "publisher-import-picker", publisherSearch],
    queryFn: () =>
      api.admin.listPublishers({
        search: publisherSearch || undefined,
        page: 1,
        limit: 100,
      }),
  })
  const categoriesQ = useQuery<Category[]>({
    queryKey: ["marketplace-categories"],
    queryFn: () => api.marketplace.getCategories(),
  })
  const acceptedCategories = useMemo(
    () =>
      (categoriesQ.data ?? [])
        .flatMap((category) => [category, ...(category.children ?? [])])
        .sort((left, right) => left.name.localeCompare(right.name)),
    [categoriesQ.data],
  )
  const historyQ = useQuery({
    queryKey: ["admin", "website-imports"],
    queryFn: () => api.admin.listWebsiteImports(),
  })
  const loadBatch = useMutation({
    mutationFn: (batchId: string) => api.admin.getWebsiteImport(batchId),
    onSuccess: (result) => {
      setBatch(result)
      window.scrollTo({ top: 0, behavior: "smooth" })
    },
    onError: (error: Error) =>
      toast.error(error.message || "Could not load import batch"),
  })

  const preview = useMutation({
    mutationFn: async () => {
      if (!publisherId || !file)
        throw new Error("Choose a publisher and CSV file")
      if (file.size > 2 * 1024 * 1024)
        throw new Error("CSV must be 2 MB or smaller")
      return api.admin.previewWebsiteImport(publisherId, file)
    },
    onSuccess: (result) => {
      setBatch(result)
      toast.success("CSV preview is ready")
      queryClient.invalidateQueries({ queryKey: ["admin", "website-imports"] })
    },
    onError: (error: Error) => toast.error(error.message || "Preview failed"),
  })

  const commit = useMutation({
    mutationFn: () => {
      if (!batch) throw new Error("Preview a CSV first")
      return api.admin.commitWebsiteImport(
        batch.id,
        `website-import:${batch.id}`,
      )
    },
    onSuccess: (result) => {
      setBatch(result)
      toast.success(`${result.createdRows} website(s) imported as drafts`)
      queryClient.invalidateQueries({ queryKey: ["admin", "website-imports"] })
    },
    onError: (error: Error) => toast.error(error.message || "Import failed"),
  })

  const createdWebsiteIds = useMemo(
    () =>
      batch?.rows
        ?.filter((row) => row.status === "CREATED" && row.websiteId)
        .map((row) => row.websiteId!) ?? [],
    [batch],
  )
  const forceVerify = useMutation({
    mutationFn: () =>
      api.admin.forceVerifyWebsites({
        websiteIds: createdWebsiteIds,
        reason: overrideReason.trim(),
        expiresInDays: Number(expiresInDays),
      }),
    onSuccess: (result) => {
      toast.success(
        `${result.verified} website(s) temporarily verified until ${new Date(result.expiresAt).toLocaleDateString()}`,
      )
      setForceDialog(false)
      setOverrideReason("")
    },
    onError: (error: Error) =>
      toast.error(error.message || "Forced verification failed"),
  })

  const canCommit =
    !!batch &&
    ["PREVIEWED", "COMMITTING"].includes(batch.status) &&
    (batch.readyRows > 0 || batch.warningRows > 0)
  const history = historyQ.data ?? []
  const visibleHistory = historyExpanded ? history : history.slice(0, 5)
  const hiddenHistoryCount = Math.max(0, history.length - 5)
  const batchCommitted =
    !!batch && ["COMPLETED", "PARTIAL"].includes(batch.status)

  return (
    <AdminPage>
      <AdminPageHeader
        title="Publisher website import"
        description="Preview and import publisher-owned websites as drafts. CSV import never verifies ownership or publishes listings."
        eyebrow="Controlled bulk intake"
        icon={Upload}
        actions={
          <Button variant="outline" asChild className="gap-2">
            <a href={`${getApiUrl()}/admin/websites/import/template`}>
              <FileDown className="h-4 w-4" /> Download CSV template
            </a>
          </Button>
        }
      />

      <AdminNotice title="Super Admin controlled workflow" tone="warning">
        Imports are publisher-bound, row-isolated and audited. Existing or
        invalid domains are skipped without blocking the remaining valid rows.
        Verification remains a separate expiring action.
      </AdminNotice>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>Prepare the CSV</CardTitle>
          <CardDescription>
            Start with the template, keep its headers unchanged and leave
            unavailable optional values blank.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4">
          <div className="grid min-w-0 gap-3 md:grid-cols-3">
            <GuidanceSummary
              title="One site per row"
              description="Use a public root URL. Existing and repeated domains are rejected row by row."
            />
            <GuidanceSummary
              title="Optional values can fail safely"
              description="Unsupported optional cells are skipped with warnings; other valid cells remain."
            />
            <GuidanceSummary
              title="Drafts only"
              description="Valid rows import as unverified drafts for the publisher to complete and review."
            />
          </div>

          <details className="min-w-0 overflow-hidden rounded-lg border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-muted/30">
              Additional CSV instructions
            </summary>
            <div className="border-t px-4 py-3">
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>
                  Use the UTF-8 template and do not add or reorder columns.
                </li>
                <li>
                  URLs cannot contain paths, queries, credentials, custom ports,
                  localhost or IP addresses.
                </li>
                <li>
                  Enum values are case-sensitive. Use plain numbers without
                  separators, currency symbols or percent signs.
                </li>
                <li>
                  Quote cells containing commas, quotes or line breaks; escape
                  an internal quote as two quotes.
                </li>
                <li>
                  Separate category slugs with{" "}
                  <code className="break-all">|</code>, for example{" "}
                  <code className="break-all">business|technology-gadgets</code>
                  .
                </li>
                <li>
                  Wrong headers, malformed quoting, shifted columns and files
                  over 2 MB are rejected before preview.
                </li>
              </ul>
            </div>
          </details>

          <details className="min-w-0 overflow-hidden rounded-lg border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-muted/30">
              Field reference ({COLUMN_GUIDANCE.length} columns)
            </summary>
            <div className="divide-y border-t">
              {COLUMN_GUIDANCE.map((column) => (
                <div
                  key={column.name}
                  className="grid min-w-0 gap-2 px-4 py-3 text-xs md:grid-cols-[12rem_8rem_minmax(0,1fr)]"
                >
                  <code className="min-w-0 break-all font-semibold text-foreground">
                    {column.name}
                  </code>
                  <span className="text-muted-foreground">
                    {column.requirement}
                  </span>
                  <div className="min-w-0 space-y-1 text-muted-foreground">
                    <p className="break-words">{column.accepted}</p>
                    <p className="break-words text-foreground/80">
                      <span className="font-medium">If invalid:</span>{" "}
                      {column.behavior}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </details>

          <details className="min-w-0 overflow-hidden rounded-lg border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-muted/30">
              Current active category slugs ({acceptedCategories.length})
            </summary>
            <div className="border-t p-4">
              {categoriesQ.isPending ? (
                <p className="text-sm text-muted-foreground">
                  Loading active categories…
                </p>
              ) : categoriesQ.isError ? (
                <p className="text-sm text-destructive">
                  Active categories could not be loaded. Retry before preparing
                  category values.
                </p>
              ) : (
                <div className="grid max-h-72 min-w-0 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                  {acceptedCategories.map((category) => (
                    <div
                      key={category.id}
                      className="min-w-0 rounded-md border bg-muted/20 px-3 py-2"
                    >
                      <p className="break-words text-sm font-medium">
                        {category.name}
                      </p>
                      <code className="break-all text-xs text-muted-foreground">
                        {category.slug}
                      </code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>

          <details className="min-w-0 overflow-hidden rounded-lg border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-muted/30">
              Supported primary languages ({MARKETPLACE_LANGUAGES.length})
            </summary>
            <p className="break-words border-t p-4 text-sm leading-6 text-muted-foreground">
              {MARKETPLACE_LANGUAGES.join(" · ")}
            </p>
          </details>
        </CardContent>
      </Card>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>1. Choose publisher and file</CardTitle>
          <CardDescription>
            The selected publisher must have an active owner account. Maximum
            500 rows and 2 MB.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-4 md:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label htmlFor="publisher-search">Find publisher</Label>
            <Input
              id="publisher-search"
              value={publisherSearch}
              onChange={(event) => setPublisherSearch(event.target.value)}
              placeholder="Search name or email"
            />
            <Select
              value={publisherId}
              onValueChange={(value) => {
                setPublisherId(value)
                setBatch(null)
              }}
            >
              <SelectTrigger aria-label="Publisher account">
                <SelectValue placeholder="Select publisher account" />
              </SelectTrigger>
              <SelectContent>
                {(publishersQ.data?.items ?? []).map((publisher) => (
                  <SelectItem key={publisher.id} value={publisher.id}>
                    {publisher.name || publisher.email || publisher.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="website-csv">CSV file</Label>
            <div className="flex min-h-12 min-w-0 items-center gap-3 rounded-lg border bg-background p-1.5 pr-3">
              <Label
                htmlFor="website-csv"
                className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md border bg-muted px-3 text-sm font-medium transition-colors hover:bg-muted/70"
              >
                <Upload className="h-4 w-4" /> Choose CSV file
              </Label>
              <span
                className="min-w-0 truncate text-sm text-muted-foreground"
                title={file?.name}
              >
                {file?.name ?? "No file selected"}
              </span>
            </div>
            <input
              id="website-csv"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-describedby="website-csv-help"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null)
                setBatch(null)
              }}
            />
            <p id="website-csv-help" className="text-xs text-muted-foreground">
              The raw file is validated in memory; only its SHA-256 hash and
              normalized preview rows are retained.
            </p>
          </div>
          <div className="md:col-span-2">
            <Button
              onClick={() => preview.mutate()}
              disabled={!publisherId || !file || preview.isPending}
              className="gap-2"
            >
              {preview.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Validate and preview
            </Button>
          </div>
        </CardContent>
      </Card>

      {batch && (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="min-w-0">
            <CardTitle>
              {batchCommitted ? "2. Import results" : "2. Review preview"}
            </CardTitle>
            <CardDescription className="break-words">
              Batch {batch.id} · {batch.fileName}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <Summary label="Total" value={batch.totalRows} />
              {batchCommitted ? (
                <>
                  <Summary label="Imported" value={batch.createdRows} />
                  <Summary label="Skipped" value={batch.skippedRows} />
                  <Summary label="Failed" value={batch.failedRows} />
                </>
              ) : (
                <>
                  <Summary label="Ready" value={batch.readyRows} />
                  <Summary label="Warnings" value={batch.warningRows} />
                  <Summary label="Errors" value={batch.errorRows} />
                </>
              )}
            </div>
            <div className="space-y-2 md:hidden">
              {(batch.rows ?? []).map((row) => (
                <div key={row.id} className="min-w-0 rounded-lg border p-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        Row {row.rowNumber}
                      </p>
                      <p className="break-all font-mono text-xs font-medium">
                        {row.canonicalDomain ?? "No valid domain"}
                      </p>
                    </div>
                    <Badge variant={ROW_BADGE[row.status]}>{row.status}</Badge>
                  </div>
                  <p className="mt-2 break-words text-xs text-muted-foreground">
                    {[...row.errors, ...row.warnings].length > 0
                      ? [...row.errors, ...row.warnings].join(" · ")
                      : "No issues"}
                  </p>
                </div>
              ))}
            </div>
            <div className="hidden min-w-0 max-w-full overflow-hidden rounded-md border md:block">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Row</TableHead>
                    <TableHead className="w-48">Domain</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead>Review notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(batch.rows ?? []).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.rowNumber}</TableCell>
                      <TableCell className="break-all font-mono text-xs">
                        {row.canonicalDomain ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={ROW_BADGE[row.status]}>
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="break-words text-xs">
                        {[...row.errors, ...row.warnings].length > 0
                          ? [...row.errors, ...row.warnings].join(" · ")
                          : "No issues"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {batch.warningRows > 0 && batch.status === "PREVIEWED" && (
              <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div>
                  <p className="font-medium">
                    {batch.warningRows} row(s) contain skipped or missing values
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    These rows can import as drafts. Review each note—the
                    publisher must complete missing information before listing
                    review.
                  </p>
                </div>
              </div>
            )}
            {batch.errorRows > 0 && batch.status === "PREVIEWED" && (
              <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div>
                  <p className="font-medium text-destructive">
                    {batch.errorRows} row(s) will be skipped
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Correct and preview a new CSV to import every row, or
                    continue to create only ready and warning rows.
                  </p>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {["PREVIEWED", "COMMITTING"].includes(batch.status) && (
                <Button
                  onClick={() => commit.mutate()}
                  disabled={!canCommit || commit.isPending}
                  className="gap-2"
                >
                  {commit.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  {batch.status === "COMMITTING"
                    ? "Resume import"
                    : "Import valid rows as drafts"}
                </Button>
              )}
              {["COMPLETED", "PARTIAL"].includes(batch.status) &&
                createdWebsiteIds.length > 0 && (
                  <Button
                    variant="destructive"
                    onClick={() => setForceDialog(true)}
                  >
                    Temporarily force TXT verification
                  </Button>
                )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>Recent imports</CardTitle>
          <CardDescription>
            Your latest Super Admin import batches.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          <div className="space-y-2 md:hidden">
            {visibleHistory.map((item) => (
              <div key={item.id} className="min-w-0 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {item.publisher?.name ?? item.publisherId}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.fileName}
                    </p>
                  </div>
                  <Badge variant="secondary">{item.status}</Badge>
                </div>
                <div className="mt-3 flex items-end justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    <p>{new Date(item.createdAt).toLocaleString()}</p>
                    <p>
                      {item.createdRows} of {item.totalRows} created
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => loadBatch.mutate(item.id)}
                    disabled={loadBatch.isPending}
                  >
                    {item.status === "COMMITTING" ? "Resume" : "View"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden min-w-0 max-w-full overflow-hidden md:block">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-48">Created</TableHead>
                  <TableHead>Publisher</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-28">Created rows</TableHead>
                  <TableHead className="w-20 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleHistory.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      {new Date(item.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="truncate">
                      {item.publisher?.name ?? item.publisherId}
                    </TableCell>
                    <TableCell className="truncate" title={item.fileName}>
                      {item.fileName}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{item.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {item.createdRows} / {item.totalRows}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => loadBatch.mutate(item.id)}
                        disabled={loadBatch.isPending}
                      >
                        {item.status === "COMMITTING" ? "Resume" : "View"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {hiddenHistoryCount > 0 && (
            <div className="mt-3 flex justify-center border-t pt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHistoryExpanded((expanded) => !expanded)}
              >
                {historyExpanded
                  ? "Show recent only"
                  : `Show ${hiddenHistoryCount} more import${hiddenHistoryCount === 1 ? "" : "s"}`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={forceDialog} onOpenChange={setForceDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporarily force verification?</DialogTitle>
            <DialogDescription>
              This break-glass action marks {createdWebsiteIds.length} imported
              website(s) as verified without DNS evidence. It expires
              automatically and is permanently audited. Listings remain drafts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="override-reason">Audit reason</Label>
              <Textarea
                id="override-reason"
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder="Explain the business need and evidence reviewed (minimum 20 characters)"
                maxLength={1000}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="override-expiry">Expires in days</Label>
              <Input
                id="override-expiry"
                type="number"
                min={1}
                max={90}
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForceDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => forceVerify.mutate()}
              disabled={
                overrideReason.trim().length < 20 ||
                Number(expiresInDays) < 1 ||
                Number(expiresInDays) > 90 ||
                forceVerify.isPending
              }
            >
              Apply temporary verification
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  )
}

function GuidanceSummary({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  )
}
