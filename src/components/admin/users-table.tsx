"use client";

import { useDeferredValue, useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

type UserRole = "member" | "merchant" | "admin";

const ROLES: UserRole[] = ["member", "merchant", "admin"];
const ROLE_KEYS: Record<UserRole, string> = {
  member: "roleMember",
  merchant: "roleMerchant",
  admin: "roleAdmin",
};
const STATUS_KEYS: Record<string, string> = {
  active: "accountActive",
  pending_funding: "accountPendingFunding",
  disabled: "accountDisabled",
};

type FormValues = {
  firstName: string;
  telegramId: string;
  telegramUsername: string;
  phone: string;
  role: UserRole;
};

const EMPTY_FORM: FormValues = {
  firstName: "",
  telegramId: "",
  telegramUsername: "",
  phone: "",
  role: "member",
};

function errorKey(data: { code?: string } | null | undefined, fallback: string): string {
  if (!data) return fallback;
  switch (data.code) {
    case "CONFLICT":
      return "errors.conflict";
    case "NOT_FOUND":
      return "errors.notFound";
    case "FORBIDDEN":
      return "errors.lastAdmin";
    default:
      return fallback;
  }
}

function CopyButton({ value }: { value: string }) {
  const t = useTranslations("admin");
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (copied) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-lg bg-zinc-100 px-2 py-1 text-xs font-medium transition-colors hover:bg-zinc-200"
    >
      {copied ? t("copied") : t("copy")}
    </button>
  );
}

function UserForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  error,
  pending,
}: {
  mode: "create" | "edit";
  initial: FormValues;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
  error: string | null;
  pending: boolean;
}) {
  const t = useTranslations("admin");
  const [values, setValues] = useState(initial);

  function setField(field: keyof FormValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-accent bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{mode === "create" ? t("addUser") : t("editUser")}</h3>
      <label className="flex flex-col gap-1 text-sm">
        <span className="opacity-70">{t("name")}</span>
        <input
          value={values.firstName}
          onChange={(e) => setField("firstName", e.target.value)}
          className="rounded-xl border border-zinc-200 bg-white p-3"
        />
      </label>
      {mode === "create" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="opacity-70">{t("telegramId")}</span>
          <input
            value={values.telegramId}
            onChange={(e) => setField("telegramId", e.target.value)}
            inputMode="numeric"
            placeholder="123456789"
            className="rounded-xl border border-zinc-200 bg-white p-3"
          />
          <span className="text-xs opacity-60">{t("telegramIdHint")}</span>
        </label>
      ) : (
        <p className="text-sm">
          <span className="opacity-70">{t("telegramId")}: </span>
          <span className="font-mono">{initial.telegramId}</span>
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="opacity-70">{t("username")}</span>
        <input
          value={values.telegramUsername}
          onChange={(e) => setField("telegramUsername", e.target.value)}
          placeholder="@username"
          className="rounded-xl border border-zinc-200 bg-white p-3"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="opacity-70">{t("phone")}</span>
        <input
          value={values.phone}
          onChange={(e) => setField("phone", e.target.value)}
          inputMode="tel"
          className="rounded-xl border border-zinc-200 bg-white p-3"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="opacity-70">{t("role")}</span>
        <select
          value={values.role}
          onChange={(e) => setField("role", e.target.value)}
          className="rounded-xl border border-zinc-200 bg-white p-3"
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {t(ROLE_KEYS[role])}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="rounded-xl bg-red-100 p-3 text-sm text-red-900">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSubmit(values)}
          disabled={pending || !values.firstName.trim()}
          className="flex-1 rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
        >
          {t("save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="flex-1 rounded-xl border border-zinc-200 px-4 py-3 font-semibold opacity-70"
        >
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

export function AdminUsersTable() {
  const t = useTranslations("admin");
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [offset, setOffset] = useState(0);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [formUserId, setFormUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncingRow, setSyncingRow] = useState<string | null>(null);

  const list = trpc.admin.users.list.useQuery({
    query: deferredQuery.trim() || undefined,
    offset,
    limit: 50,
  });

  const create = trpc.admin.users.create.useMutation({
    onSuccess: () => {
      utils.admin.users.list.invalidate();
      setFormMode(null);
    },
    onError: (err) => setError(t(errorKey(err.data, "errors.generic"))),
  });
  const update = trpc.admin.users.update.useMutation({
    onSuccess: () => {
      utils.admin.users.list.invalidate();
      setFormMode(null);
    },
    onError: (err) => setError(t(errorKey(err.data, "errors.generic"))),
  });
  const sync = trpc.admin.users.syncBalance.useMutation({
    onSuccess: () => {
      utils.admin.users.list.invalidate();
    },
    onError: (err) => setError(t(errorKey(err.data, "errors.generic"))),
  });

  const items = list.data?.items ?? [];
  const hasMore = list.data?.hasMore ?? false;
  const pageSize = 50;
  const editing = formMode === "edit" ? items.find((u) => u.id === formUserId) ?? null : null;
  const formInitial: FormValues | null =
    formMode === "create"
      ? EMPTY_FORM
      : editing
        ? {
            firstName: editing.firstName,
            telegramId: editing.telegramId,
            telegramUsername: editing.telegramUsername ?? "",
            phone: editing.phone ?? "",
            role: editing.role,
          }
        : null;

  if (list.isError) {
    const code = (list.error?.data as { code?: string } | undefined)?.code;
    return (
      <p className="rounded-xl bg-red-100 p-3 text-red-900">
        {code === "FORBIDDEN" ? t("notAdmin") : t("errors.generic")}
      </p>
    );
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setOffset(0);
  }

  function openCreate() {
    setError(null);
    setFormMode("create");
    setFormUserId(null);
  }

  function openEdit(user: (typeof items)[number]) {
    setError(null);
    setFormMode("edit");
    setFormUserId(user.id);
  }

  function handleSubmit(values: FormValues) {
    setError(null);
    if (formMode === "create") {
      create.mutate({
        firstName: values.firstName.trim(),
        telegramId: values.telegramId.trim() || undefined,
        telegramUsername: values.telegramUsername.trim() || undefined,
        phone: values.phone.trim() || undefined,
        role: values.role,
      });
    } else if (formUserId) {
      update.mutate({
        userId: formUserId,
        firstName: values.firstName.trim(),
        telegramUsername: values.telegramUsername.trim() || undefined,
        phone: values.phone.trim() || null,
        role: values.role,
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <input
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="rounded-xl border border-zinc-200 bg-white p-3"
        />
        <button
          type="button"
          onClick={openCreate}
          className="rounded-xl border border-accent px-4 py-3 font-semibold text-accent"
        >
          {t("addUser")}
        </button>
      </div>

      {formMode && formInitial && (
        <UserForm
          key={`${formMode}-${formUserId ?? "new"}`}
          mode={formMode}
          initial={formInitial}
          onSubmit={handleSubmit}
          onCancel={() => setFormMode(null)}
          error={error}
          pending={create.isPending || update.isPending}
        />
      )}

      {list.isPending ? (
        <p className="opacity-60">{t("loading")}</p>
      ) : items.length === 0 ? (
        <p className="opacity-60">{t("noUsers")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((user) => (
            <li key={user.id} className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">
                    {user.firstName}
                    {user.telegramUsername && (
                      <span className="text-sm font-normal opacity-60">
                        {" "}
                        @{user.telegramUsername}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs opacity-60">
                    {t("role")}: {t(ROLE_KEYS[user.role])}
                  </p>
                  <p className="text-xs opacity-60">
                    {t("createdAt")}: {new Date(user.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-lg font-bold">
                    {user.balance.toString()} {t("tak")}
                  </span>
                  <span className="text-xs opacity-60">
                    {user.accountStatus
                      ? t(STATUS_KEYS[user.accountStatus] ?? user.accountStatus)
                      : t("accountNone")}
                  </span>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                {user.publicKey ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-xs text-zinc-600">
                      {user.publicKey}
                    </span>
                    <CopyButton value={user.publicKey} />
                  </div>
                ) : (
                  <span className="text-xs opacity-60">{t("accountNone")}</span>
                )}
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setSyncingRow(user.id);
                      sync.mutate(
                        { userId: user.id },
                        { onSettled: () => setSyncingRow(null) },
                      );
                    }}
                    disabled={syncingRow === user.id}
                    className="rounded-lg bg-zinc-100 px-2 py-1 text-xs font-medium transition-colors hover:bg-zinc-200 disabled:opacity-50"
                  >
                    {syncingRow === user.id ? t("syncing") : t("sync")}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(user)}
                    className="rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium"
                  >
                    {t("editUser")}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && formMode === null && (
        <p className="rounded-xl bg-red-100 p-3 text-red-900">{error}</p>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
          disabled={offset === 0}
          className="rounded-xl border border-zinc-200 px-4 py-2 font-semibold disabled:opacity-40"
        >
          {t("previous")}
        </button>
        <button
          type="button"
          onClick={() => setOffset(offset + pageSize)}
          disabled={!hasMore}
          className="rounded-xl border border-zinc-200 px-4 py-2 font-semibold disabled:opacity-40"
        >
          {t("next")}
        </button>
      </div>
    </div>
  );
}
