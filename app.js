// KeepTrack — static frontend (Phase 3)
//
// Talks directly to Supabase for auth + data. Without ./config.js it falls
// back to an in-memory mock so you can poke at the UI.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Production defaults — safe to ship (anon key is public; RLS protects data).
const DEFAULTS = {
  SUPABASE_URL: "https://dzdizortbzvfeiksfylp.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_VXC95soOBAVXHzvSMGO0BQ_ggtmY3Vv",
};

let supabase = null;
let config = null;

try {
  const mod = await import("./config.js");
  config = mod.default ?? mod;
} catch (_err) {
  // No config.js — use production defaults (GitHub Pages).
  config = DEFAULTS;
}

if (
  config?.SUPABASE_URL &&
  config?.SUPABASE_ANON_KEY &&
  !config.SUPABASE_URL.includes("YOUR-PROJECT")
) {
  supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
}

const isMock = () => supabase === null;

// Default tag color palette (used in the new-tag color picker).
const COLOR_PALETTE = [
  "#6366f1", // indigo
  "#22c55e", // green
  "#f97316", // orange
  "#ef4444", // red
  "#eab308", // yellow
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#ec4899", // pink
  "#94a3b8", // slate
  "#10b981", // emerald
];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  authArea: $("auth-area"),
  signedOut: $("signed-out"),
  signedIn: $("signed-in"),
  loading: $("loading"),
  signInBtn: $("sign-in-btn"),
  newTaskForm: $("new-task-form"),
  newTaskTitle: $("new-task-title"),
  taskList: $("task-list"),
  emptyHint: $("empty-hint"),
  filterState: $("filter-state"),
  filterPriority: $("filter-priority"),
  filterTag: $("filter-tag"),
  sortBy: $("sort-by"),
  manageTagsBtn: $("manage-tags-btn"),
  integrationsBtn: $("integrations-btn"),
  // Integrations modal
  intModal: $("integrations-modal"),
  gmailStatus: $("gmail-status"),
  gmailConnect: $("gmail-connect"),
  gmailDisconnect: $("gmail-disconnect"),
  slackStatus: $("slack-status"),
  slackDisconnect: $("slack-disconnect"),
  slackTeamInput: $("slack-team-input"),
  slackUserInput: $("slack-user-input"),
  slackTokenInput: $("slack-token-input"),
  slackSaveBtn: $("slack-save-btn"),
  slackForm: $("slack-form"),
  // Edit modal
  editModal: $("edit-modal"),
  editForm: $("edit-form"),
  editTitle: $("edit-field-title"),
  editNotes: $("edit-field-notes"),
  editDue: $("edit-field-due"),
  editPriority: $("edit-field-priority"),
  editTagsContainer: $("edit-field-tags"),
  openTagMgrFromEdit: $("open-tag-mgr-from-edit"),
  editDelete: $("edit-delete"),
  // Tag manager modal
  tagsModal: $("tags-modal"),
  newTagForm: $("new-tag-form"),
  newTagName: $("new-tag-name"),
  newTagColor: $("new-tag-color"),
  tagMgrList: $("tag-mgr-list"),
  tagMgrEmpty: $("tag-mgr-empty"),
};

// ---------- State ----------
let session = null;
let tasks = [];
// tags keyed by id and by name for both kinds of lookup
let tagsById = new Map();
let tagsByName = new Map();
let editing = null; // { task, draftTagIds: Set<string> }
const justDoneIds = new Set();
let newTagSelectedColor = COLOR_PALETTE[0];
let filterState = "open";
let filterPriority = "all";
let filterTag = "all";
let sortBy = "due_at";
let gmailIntegration = null; // { user_id, provider, access_token, ... } or null
let slackIntegration = null;

// ---------- Mock store ----------
const mock = {
  user: { id: "mock-user", email: "you@local" },
  nextTaskId: 2,
  nextTagId: 2,
  tags: [{ id: "t1", name: "demo", color: "#6366f1" }],
  tasks: [
    {
      id: "m1",
      user_id: "mock-user",
      title: "Try KeepTrack — click me to edit",
      notes: "Set due, priority, and tags from the modal.",
      due_at: null,
      priority: "med",
      completed_at: null,
      source_url: null,
      created_at: new Date().toISOString(),
      tag_ids: ["t1"],
    },
  ],
};

// ---------- Auth ----------
async function signIn() {
  if (isMock()) {
    session = { user: mock.user };
    await refresh();
    return;
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + window.location.pathname,
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });
  if (error) alert("Sign-in failed: " + error.message);
}

async function signOut() {
  if (isMock()) {
    session = null;
    await refresh();
    return;
  }
  await supabase.auth.signOut();
  session = null;
  tasks = [];
  tagsById.clear();
  tagsByName.clear();
  await refresh();
}

async function loadSession() {
  if (isMock()) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// ---------- Data ----------
function indexTags(tagRows) {
  tagsById = new Map();
  tagsByName = new Map();
  for (const t of tagRows) {
    tagsById.set(t.id, t);
    tagsByName.set(t.name, t);
  }
}

async function fetchAll() {
  if (isMock()) {
    indexTags(mock.tags);
    tasks = mock.tasks.map((t) => ({ ...t, tag_ids: [...(t.tag_ids ?? [])] }));
    gmailIntegration = null;
    slackIntegration = null;
    return;
  }

  const [tasksRes, tagsRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("*, task_tags(tag_id)")
      .order("created_at", { ascending: false }),
    supabase.from("tags").select("id,name,color").order("name", { ascending: true }),
    fetchIntegrations(),
  ]);

  if (tagsRes.error) console.error(tagsRes.error);
  indexTags(tagsRes.data ?? []);

  if (tasksRes.error) {
    console.error(tasksRes.error);
    tasks = [];
  } else {
    tasks = tasksRes.data.map((t) => ({
      ...t,
      tag_ids: (t.task_tags ?? []).map((tt) => tt.tag_id),
    }));
  }
}

async function createTask(title) {
  if (isMock()) {
    mock.tasks.unshift({
      id: "m" + mock.nextTaskId++,
      user_id: mock.user.id,
      title,
      notes: null,
      due_at: null,
      priority: "med",
      completed_at: null,
      source_url: null,
      created_at: new Date().toISOString(),
      tag_ids: [],
    });
    return;
  }
  const { error } = await supabase.from("tasks").insert({ title });
  if (error) alert("Create failed: " + error.message);
}

async function updateTask(id, patch) {
  if (isMock()) {
    const t = mock.tasks.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
    return;
  }
  const { error } = await supabase.from("tasks").update(patch).eq("id", id);
  if (error) alert("Update failed: " + error.message);
}

async function deleteTask(id) {
  if (isMock()) {
    mock.tasks = mock.tasks.filter((t) => t.id !== id);
    return;
  }
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) alert("Delete failed: " + error.message);
}

async function syncTaskTags(taskId, desiredIds) {
  if (isMock()) {
    const t = mock.tasks.find((x) => x.id === taskId);
    if (t) t.tag_ids = [...desiredIds];
    return;
  }
  const { data: current } = await supabase
    .from("task_tags")
    .select("tag_id")
    .eq("task_id", taskId);
  const currentIds = new Set((current ?? []).map((r) => r.tag_id));
  const desired = new Set(desiredIds);

  const toAdd = [...desired].filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !desired.has(id));

  if (toAdd.length) {
    await supabase
      .from("task_tags")
      .insert(toAdd.map((tag_id) => ({ task_id: taskId, tag_id })));
  }
  if (toRemove.length) {
    await supabase
      .from("task_tags")
      .delete()
      .eq("task_id", taskId)
      .in("tag_id", toRemove);
  }
}

// ---------- Tag CRUD ----------
async function createTag(name, color) {
  if (isMock()) {
    if (mock.tags.some((t) => t.name === name)) {
      alert("Tag already exists");
      return null;
    }
    const tag = { id: "t" + mock.nextTagId++, name, color };
    mock.tags.push(tag);
    return tag;
  }
  const { data, error } = await supabase
    .from("tags")
    .insert({ name, color })
    .select("id,name,color")
    .single();
  if (error) {
    alert("Create tag failed: " + error.message);
    return null;
  }
  return data;
}

async function updateTag(id, patch) {
  if (isMock()) {
    const t = mock.tags.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
    return;
  }
  const { error } = await supabase.from("tags").update(patch).eq("id", id);
  if (error) alert("Update tag failed: " + error.message);
}

async function deleteTag(id) {
  if (isMock()) {
    mock.tags = mock.tags.filter((t) => t.id !== id);
    for (const task of mock.tasks) {
      task.tag_ids = (task.tag_ids ?? []).filter((tid) => tid !== id);
    }
    return;
  }
  const { error } = await supabase.from("tags").delete().eq("id", id);
  if (error) alert("Delete tag failed: " + error.message);
}

// ---------- Integrations ----------
async function fetchIntegrations() {
  if (isMock()) {
    gmailIntegration = null;
    slackIntegration = null;
    return;
  }
  const { data } = await supabase
    .from("integrations")
    .select("user_id, provider, access_token, refresh_token, scope, metadata, installed_at");
  gmailIntegration = data?.find((i) => i.provider === "gmail") ?? null;
  slackIntegration = data?.find((i) => i.provider === "slack") ?? null;
}

async function connectGmail() {
  if (isMock()) return;
  // The provider_token and provider_refresh_token come from the Google OAuth
  // session — Supabase makes them available after sign-in with scopes.
  const { data: sessionData } = await supabase.auth.getSession();
  const s = sessionData?.session;
  if (!s?.provider_token) {
    alert(
      "Gmail access token not available. Please sign out and sign back in to grant Gmail permissions.",
    );
    return;
  }
  const { error } = await supabase.from("integrations").upsert(
    {
      user_id: s.user.id,
      provider: "gmail",
      access_token: s.provider_token,
      refresh_token: s.provider_refresh_token ?? null,
      scope: "gmail.readonly",
    },
    { onConflict: "user_id,provider" },
  );
  if (error) {
    alert("Failed to connect Gmail: " + error.message);
    return;
  }
  await fetchIntegrations();
  renderIntegrationsModal();
}

async function disconnectGmail() {
  if (isMock()) return;
  await supabase
    .from("integrations")
    .delete()
    .eq("provider", "gmail");
  gmailIntegration = null;
  renderIntegrationsModal();
}

async function saveSlackIntegration(e) {
  e.preventDefault();
  if (isMock()) return;
  const teamId = els.slackTeamInput.value.trim();
  const slackUserId = els.slackUserInput.value.trim();
  const botToken = els.slackTokenInput.value.trim();
  if (!teamId || !slackUserId || !botToken) {
    alert("Please fill in all Slack fields.");
    return;
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) return;

  const { error } = await supabase.from("integrations").upsert(
    {
      user_id: userId,
      provider: "slack",
      access_token: botToken,
      metadata: { team_id: teamId, slack_user_id: slackUserId },
    },
    { onConflict: "user_id,provider" },
  );
  if (error) {
    alert("Failed to save Slack integration: " + error.message);
    return;
  }
  await fetchIntegrations();
  renderIntegrationsModal();
}

async function disconnectSlack() {
  if (isMock()) return;
  await supabase
    .from("integrations")
    .delete()
    .eq("provider", "slack");
  slackIntegration = null;
  renderIntegrationsModal();
}

function openIntegrations() {
  renderIntegrationsModal();
  els.intModal.hidden = false;
}

function closeIntegrations() {
  els.intModal.hidden = true;
}

function renderIntegrationsModal() {
  // Gmail
  if (gmailIntegration) {
    els.gmailStatus.textContent = "Connected";
    els.gmailStatus.className = "integration-status connected";
    els.gmailConnect.hidden = true;
    els.gmailDisconnect.hidden = false;
  } else {
    els.gmailStatus.textContent = "Not connected";
    els.gmailStatus.className = "integration-status";
    els.gmailConnect.hidden = false;
    els.gmailDisconnect.hidden = true;
  }

  // Slack
  if (slackIntegration) {
    els.slackStatus.textContent =
      `Connected (team: ${slackIntegration.metadata?.team_id ?? "?"})`;
    els.slackStatus.className = "integration-status connected";
    els.slackForm.hidden = true;
    els.slackDisconnect.hidden = false;
  } else {
    els.slackStatus.textContent = "Not connected";
    els.slackStatus.className = "integration-status";
    els.slackForm.hidden = false;
    els.slackDisconnect.hidden = true;
  }
}

// ---------- Render ----------
function render() {
  els.authArea.innerHTML = "";
  if (session?.user) {
    const email = document.createElement("span");
    email.textContent = session.user.email ?? "signed in";
    const out = document.createElement("button");
    out.className = "btn link";
    out.textContent = "Sign out";
    out.addEventListener("click", signOut);
    els.authArea.append(email, out);
  } else {
    const mode = document.createElement("span");
    mode.textContent = isMock() ? "local demo" : "not signed in";
    els.authArea.append(mode);
  }

  els.loading.hidden = true;
  els.signedOut.hidden = !!session;
  els.signedIn.hidden = !session;

  if (!session) return;

  // Tag filter dropdown — keyed by id, label by name
  const sortedTags = [...tagsById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const currentTag = els.filterTag.value;
  els.filterTag.innerHTML = '<option value="all">All tags</option>';
  for (const tag of sortedTags) {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    els.filterTag.append(opt);
  }
  if (currentTag === "all" || tagsById.has(currentTag)) {
    els.filterTag.value = currentTag;
  } else {
    els.filterTag.value = "all";
    filterTag = "all";
  }

  // Filter + sort
  // "Open" view keeps tasks marked done on the current Eastern-time day so
  // satisfying checks don't make them vanish — they roll off at midnight ET.
  const sameEasternDay = (iso) => {
    if (!iso) return false;
    return easternDayKey(new Date(iso)) === easternDayKey(new Date());
  };
  let list = tasks.slice();
  if (filterState === "open") {
    list = list.filter((t) => !t.completed_at || sameEasternDay(t.completed_at));
  }
  if (filterState === "done") list = list.filter((t) => t.completed_at);
  if (filterPriority !== "all") list = list.filter((t) => t.priority === filterPriority);
  if (filterTag !== "all") {
    list = list.filter((t) => (t.tag_ids ?? []).includes(filterTag));
  }

  const priOrder = { high: 0, med: 1, low: 2 };
  const innerSort = (a, b) => {
    if (sortBy === "priority") {
      return (priOrder[a.priority] ?? 9) - (priOrder[b.priority] ?? 9);
    }
    if (sortBy === "created_at") {
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    }
    // due_at fallback within a group: stable by created
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  };

  // ---------- Group by due date ----------
  const groups = groupByDueBucket(list);
  for (const g of groups) g.tasks.sort(innerSort);

  els.taskList.innerHTML = "";
  els.emptyHint.hidden = list.length > 0;

  const now = Date.now();
  for (const group of groups) {
    // Overdue tasks get wrapped in an attention container.
    const isOverdue = group.key === "overdue";
    let wrapper = null;
    if (isOverdue) {
      wrapper = document.createElement("li");
      wrapper.className = "overdue-wrapper";
    }
    const parent = wrapper ?? els.taskList;

    const header = document.createElement("li");
    header.className = "section-header " + group.cssClass;
    header.textContent = group.label;
    parent.append(header);

    for (const t of group.tasks) {
      const li = document.createElement("li");
      li.className = "task";
      li.tabIndex = 0;
      li.dataset.taskId = t.id;
      if (t.completed_at) li.classList.add("done");
      if (t.due_at && !t.completed_at && Date.parse(t.due_at) < now) {
        li.classList.add("overdue");
      }

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = !!t.completed_at;
    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", async () => {
      if (check.checked) {
        // Mark for one-shot animation on the next render.
        justDoneIds.add(t.id);
        // Fire confetti immediately on the current row for instant feedback.
        spawnConfetti(li);
      }
      await updateTask(t.id, {
        completed_at: check.checked ? new Date().toISOString() : null,
      });
      await refresh();
    });

    if (justDoneIds.has(t.id)) {
      li.classList.add("just-done");
      // Drop the marker after the animation finishes so re-renders are calm.
      setTimeout(() => {
        justDoneIds.delete(t.id);
        li.classList.remove("just-done");
      }, 900);
    }

    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = t.title;
    body.append(title);

    if (t.notes) {
      const notesPreview = document.createElement("div");
      notesPreview.className = "notes-preview";
      notesPreview.textContent = t.notes;
      body.append(notesPreview);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    if (t.priority === "high" || t.priority === "low") {
      const p = document.createElement("span");
      p.className = `priority-chip priority-${t.priority}`;
      p.textContent = t.priority;
      meta.append(p);
    }
    for (const tagId of t.tag_ids ?? []) {
      const tag = tagsById.get(tagId);
      if (!tag) continue;
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.style.backgroundColor = tag.color + "22";
      chip.style.borderColor = tag.color + "66";
      chip.style.color = tag.color;
      chip.textContent = tag.name;
      meta.append(chip);
    }
    if (meta.childElementCount) body.append(meta);

      li.append(check, body);
      li.addEventListener("click", () => openEdit(t));
      parent.append(li);
    }

    if (wrapper) els.taskList.append(wrapper);
  }
}

// Returns YYYY-MM-DD for the given Date as observed in America/New_York.
// Used for "midnight Eastern" rollover semantics.
function easternDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function groupByDueBucket(list) {
  // Buckets:
  //   Overdue
  //   Today (always)
  //   Each remaining weekday (Mon–Fri) of THIS business week, individually
  //   Next week (Sat of this week through Sun of next week)
  //   Beyond (anything after that)
  //   No due date
  const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return startOfDay(x);
  };
  const dayKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  const formatWeekday = (d) =>
    d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

  const today = startOfDay(new Date());
  const todayDow = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  // Friday of this calendar week (Mon-Sun week). If today is Sat/Sun, this Friday is in the past.
  const daysUntilFriday = (5 - todayDow + 7) % 7; // 0..6
  const thisFriday = addDays(today, daysUntilFriday);
  // If today is Sat or Sun, the "Friday of this week" calc above gives next Friday.
  // For our purposes, treat the current business week as already over in that case.
  const businessWeekOver = todayDow === 0 || todayDow === 6;

  // End of "next week" = Sunday after thisFriday (i.e. the Sunday at the end of next week).
  // If business week is over, "next week" = the upcoming Mon-Sun.
  let nextWeekEnd;
  if (businessWeekOver) {
    // Next week: from today through next Sunday.
    const daysUntilSun = (7 - todayDow) % 7 || 7;
    nextWeekEnd = addDays(today, daysUntilSun);
  } else {
    // From Saturday (thisFriday + 1) through next Sunday (thisFriday + 9).
    nextWeekEnd = addDays(thisFriday, 9);
  }

  const overdue = {
    key: "overdue",
    label: "Overdue",
    cssClass: "is-overdue",
    tasks: [],
  };
  const todayG = { key: "today", label: "Today", cssClass: "is-today", tasks: [] };
  const dayMap = new Map(); // for tomorrow..thisFriday
  const nextWeek = {
    key: "next-week",
    label: "Next week",
    cssClass: "is-next-week",
    tasks: [],
  };
  const beyond = {
    key: "beyond",
    label: "Beyond",
    cssClass: "is-beyond",
    tasks: [],
  };
  const noDate = {
    key: "none",
    label: "No due date",
    cssClass: "is-none",
    tasks: [],
  };

  // Pre-create individual day buckets for the rest of this business week.
  const individualDayKeys = [];
  if (!businessWeekOver) {
    let cursor = addDays(today, 1);
    while (cursor.getTime() <= thisFriday.getTime()) {
      const dow = cursor.getDay();
      if (dow >= 1 && dow <= 5) {
        const key = dayKey(cursor);
        dayMap.set(key, {
          key,
          label: formatWeekday(cursor),
          cssClass: "is-day",
          tasks: [],
          sortDate: cursor.getTime(),
        });
        individualDayKeys.push(key);
      }
      cursor = addDays(cursor, 1);
    }
  }

  for (const t of list) {
    if (!t.due_at) {
      noDate.tasks.push(t);
      continue;
    }
    const dueDay = startOfDay(new Date(t.due_at));
    const dueTime = dueDay.getTime();

    if (dueTime < today.getTime()) {
      overdue.tasks.push(t);
    } else if (dueTime === today.getTime()) {
      todayG.tasks.push(t);
    } else if (dayMap.has(dayKey(dueDay))) {
      dayMap.get(dayKey(dueDay)).tasks.push(t);
    } else if (dueTime <= nextWeekEnd.getTime()) {
      nextWeek.tasks.push(t);
    } else {
      beyond.tasks.push(t);
    }
  }

  const orderedDays = individualDayKeys.map((k) => dayMap.get(k));
  const ordered = [noDate, overdue, todayG, ...orderedDays, nextWeek, beyond];
  return ordered.filter((g) => g.tasks.length > 0);
}

function spawnConfetti(taskEl) {
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  taskEl.append(layer);

  const colors = [
    "#22c55e",
    "#6366f1",
    "#f97316",
    "#eab308",
    "#06b6d4",
    "#ec4899",
  ];
  const PIECES = 14;
  for (let i = 0; i < PIECES; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.background = colors[i % colors.length];
    const angle = (Math.PI / PIECES) * i + Math.random() * 0.4;
    const distance = 50 + Math.random() * 35;
    const dx = Math.cos(angle) * distance * (Math.random() > 0.5 ? 1 : -1);
    const dy = Math.sin(angle) * -distance - 10; // bias upward
    const rot = Math.floor(Math.random() * 540 - 270);
    piece.style.setProperty("--dx", `${dx}px`);
    piece.style.setProperty("--dy", `${dy}px`);
    piece.style.setProperty("--rot", `${rot}deg`);
    layer.append(piece);
  }
  setTimeout(() => layer.remove(), 1000);
}

async function refresh() {
  if (session) await fetchAll();
  render();
}

// ---------- Edit modal ----------
function isoToDateInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateInputToIso(yyyyMmDd) {
  if (!yyyyMmDd) return null;
  return new Date(`${yyyyMmDd}T12:00:00Z`).toISOString();
}

function openEdit(task) {
  editing = { task, draftTagIds: new Set(task.tag_ids ?? []) };
  els.editTitle.value = task.title ?? "";
  els.editNotes.value = task.notes ?? "";
  els.editDue.value = isoToDateInputValue(task.due_at);
  els.editPriority.value = task.priority ?? "med";
  renderEditTagGrid();
  els.editModal.hidden = false;
  setTimeout(() => els.editTitle.focus(), 0);
}

function closeEdit() {
  editing = null;
  els.editModal.hidden = true;
}

function renderEditTagGrid() {
  els.editTagsContainer.innerHTML = "";
  const sorted = [...tagsById.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (sorted.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty-inline";
    empty.textContent = "No tags yet — create one in Manage tags.";
    els.editTagsContainer.append(empty);
    return;
  }
  for (const tag of sorted) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tag-toggle";
    btn.style.color = tag.color;
    if (editing.draftTagIds.has(tag.id)) btn.classList.add("on");

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = tag.color;
    btn.append(swatch);

    const label = document.createElement("span");
    label.textContent = tag.name;
    btn.append(label);

    btn.addEventListener("click", () => {
      if (editing.draftTagIds.has(tag.id)) editing.draftTagIds.delete(tag.id);
      else editing.draftTagIds.add(tag.id);
      btn.classList.toggle("on");
    });
    els.editTagsContainer.append(btn);
  }
}

async function saveEdit(e) {
  e.preventDefault();
  if (!editing) return;
  const { task } = editing;
  const patch = {
    title: els.editTitle.value.trim(),
    notes: els.editNotes.value.trim() || null,
    due_at: dateInputToIso(els.editDue.value),
    priority: els.editPriority.value,
  };
  await updateTask(task.id, patch);
  await syncTaskTags(task.id, [...editing.draftTagIds]);
  closeEdit();
  await refresh();
}

async function deleteFromEdit() {
  if (!editing) return;
  const { task } = editing;
  if (!confirm("Delete this task?")) return;
  await deleteTask(task.id);
  closeEdit();
  await refresh();
}

// ---------- Tag manager modal ----------
function openTagManager() {
  newTagSelectedColor = COLOR_PALETTE[0];
  els.newTagName.value = "";
  renderColorSwatches();
  renderTagMgrList();
  els.tagsModal.hidden = false;
  setTimeout(() => els.newTagName.focus(), 0);
}

function closeTagManager() {
  els.tagsModal.hidden = true;
  // After tag changes, the open edit modal (if any) needs its grid refreshed.
  if (editing) renderEditTagGrid();
  render();
}

function renderColorSwatches() {
  els.newTagColor.innerHTML = "";
  for (const c of COLOR_PALETTE) {
    const b = document.createElement("button");
    b.type = "button";
    b.style.backgroundColor = c;
    if (c === newTagSelectedColor) b.classList.add("selected");
    b.title = c;
    b.addEventListener("click", () => {
      newTagSelectedColor = c;
      renderColorSwatches();
    });
    els.newTagColor.append(b);
  }
}

function renderTagMgrList() {
  els.tagMgrList.innerHTML = "";
  const sorted = [...tagsById.values()].sort((a, b) => a.name.localeCompare(b.name));
  els.tagMgrEmpty.hidden = sorted.length > 0;

  for (const tag of sorted) {
    const li = document.createElement("li");
    li.className = "tag-mgr-row";

    // Color picker for the row — reuses palette
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "swatch";
    swatch.style.backgroundColor = tag.color;
    swatch.title = "Change color";
    swatch.addEventListener("click", async () => {
      const idx = COLOR_PALETTE.indexOf(tag.color);
      const next = COLOR_PALETTE[(idx + 1) % COLOR_PALETTE.length];
      await updateTag(tag.id, { color: next });
      await fetchAll();
      renderTagMgrList();
    });
    li.append(swatch);

    // Inline editable name
    const input = document.createElement("input");
    input.type = "text";
    input.className = "name-input";
    input.value = tag.name;
    input.addEventListener("change", async () => {
      const newName = input.value.trim();
      if (!newName || newName === tag.name) {
        input.value = tag.name;
        return;
      }
      await updateTag(tag.id, { name: newName });
      await fetchAll();
      renderTagMgrList();
    });
    li.append(input);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn link danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (
        !confirm(
          `Delete tag "${tag.name}"? It will be removed from any tasks using it.`,
        )
      )
        return;
      await deleteTag(tag.id);
      await fetchAll();
      renderTagMgrList();
    });
    li.append(del);

    els.tagMgrList.append(li);
  }
}

async function handleNewTagSubmit(e) {
  e.preventDefault();
  const name = els.newTagName.value.trim();
  if (!name) return;
  const created = await createTag(name, newTagSelectedColor);
  if (!created) return;
  els.newTagName.value = "";
  await fetchAll();
  renderTagMgrList();
}

// ---------- Wire up ----------
els.signInBtn.addEventListener("click", signIn);

let openAfterCreate = false;

els.newTaskTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openAfterCreate = true;
    els.newTaskForm.requestSubmit();
  }
});

els.newTaskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = els.newTaskTitle.value.trim();
  if (!title) return;
  const shouldOpen = openAfterCreate;
  openAfterCreate = false;
  await createTask(title);
  els.newTaskTitle.value = "";
  await refresh();
  if (shouldOpen) {
    // The newest task is the one we just created.
    const created = tasks.find((t) => t.title === title);
    if (created) openEdit(created);
  }
});

els.filterState.addEventListener("change", () => {
  filterState = els.filterState.value;
  render();
});
els.filterPriority.addEventListener("change", () => {
  filterPriority = els.filterPriority.value;
  render();
});
els.filterTag.addEventListener("change", () => {
  filterTag = els.filterTag.value;
  render();
});
els.sortBy.addEventListener("change", () => {
  sortBy = els.sortBy.value;
  render();
});

// Open the native date picker when the field is clicked or focused —
// Chrome only does this for the icon by default.
els.editDue.addEventListener("click", () => {
  if (typeof els.editDue.showPicker === "function") els.editDue.showPicker();
});
els.editDue.addEventListener("focus", () => {
  if (typeof els.editDue.showPicker === "function") els.editDue.showPicker();
});

els.editForm.addEventListener("submit", saveEdit);
els.editDelete.addEventListener("click", deleteFromEdit);
els.editModal.querySelectorAll("[data-close]").forEach((el) =>
  el.addEventListener("click", closeEdit),
);
els.openTagMgrFromEdit.addEventListener("click", openTagManager);

els.manageTagsBtn.addEventListener("click", openTagManager);
els.newTagForm.addEventListener("submit", handleNewTagSubmit);
els.tagsModal.querySelectorAll("[data-close]").forEach((el) =>
  el.addEventListener("click", closeTagManager),
);

els.integrationsBtn.addEventListener("click", openIntegrations);
els.gmailConnect.addEventListener("click", connectGmail);
els.gmailDisconnect.addEventListener("click", disconnectGmail);
els.slackForm.addEventListener("submit", saveSlackIntegration);
els.slackDisconnect.addEventListener("click", disconnectSlack);
els.intModal.querySelectorAll("[data-close]").forEach((el) =>
  el.addEventListener("click", closeIntegrations),
);

function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

function focusedTaskEl() {
  const el = document.activeElement;
  if (el && el.classList && el.classList.contains("task")) return el;
  return null;
}

function findTaskById(id) {
  return tasks.find((t) => t.id === id) ?? null;
}

document.addEventListener("keydown", (e) => {
  // Escape: close whichever modal is open.
  if (e.key === "Escape") {
    if (!els.intModal.hidden) {
      closeIntegrations();
      return;
    }
    if (!els.tagsModal.hidden) {
      closeTagManager();
      return;
    }
    if (!els.editModal.hidden) {
      closeEdit();
      return;
    }
  }

  // ⌘↩ / Ctrl+Enter: save the edit modal.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    if (!els.editModal.hidden) {
      e.preventDefault();
      els.editForm.requestSubmit();
      return;
    }
  }

  // The remaining shortcuts only apply when no modal is open and the user
  // isn't typing into a text field.
  const modalOpen = !els.editModal.hidden || !els.tagsModal.hidden || !els.intModal.hidden;
  if (modalOpen) return;
  if (isTextInput(document.activeElement)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // N or / — focus the new-task input.
  if (e.key === "n" || e.key === "N" || e.key === "/") {
    e.preventDefault();
    els.newTaskTitle.focus();
    els.newTaskTitle.select();
    return;
  }

  // ↑ / ↓ — move selection between tasks.
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const taskEls = [...els.taskList.querySelectorAll(".task")];
    if (!taskEls.length) return;
    e.preventDefault();
    const current = focusedTaskEl();
    let idx = current ? taskEls.indexOf(current) : -1;
    if (idx === -1) {
      idx = e.key === "ArrowDown" ? 0 : taskEls.length - 1;
    } else {
      idx = e.key === "ArrowDown" ? idx + 1 : idx - 1;
      idx = Math.max(0, Math.min(taskEls.length - 1, idx));
    }
    taskEls[idx].focus();
    taskEls[idx].scrollIntoView({ block: "nearest" });
    return;
  }

  // E, Space, X — act on the currently focused task.
  const focused = focusedTaskEl();
  if (!focused) return;
  const task = findTaskById(focused.dataset.taskId);
  if (!task) return;

  if (e.key === "e" || e.key === "E") {
    e.preventDefault();
    openEdit(task);
    return;
  }

  if (e.key === " " || e.key === "x" || e.key === "X") {
    e.preventDefault();
    const checkbox = focused.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  }
});

if (!isMock()) {
  supabase.auth.onAuthStateChange((_event, s) => {
    session = s;
    refresh();
  });
}

(async () => {
  session = isMock() ? null : await loadSession();
  await refresh();
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
