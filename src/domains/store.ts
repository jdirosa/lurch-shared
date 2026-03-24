import type { UserContext } from "../users.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "..", "..", "lists.json");

// --- Storage types ---

export interface GiftEntry {
  birthday?: string;
  notes?: string;
  ideas: string[];
}

export interface TripBooking {
  category: string;
  details: string;
}

export interface TripDay {
  day: string;
  items: string[];
}

export interface TripEntry {
  destination: string;
  start_date?: string;
  end_date?: string;
  notes?: string;
  ideas: string[];
  itinerary: TripDay[];
  bookings: TripBooking[];
}

export interface Recipe {
  name: string;
  notes?: string;
  ingredients: string[];
  steps?: string[];
}

export interface ScheduleEntry {
  id: string;
  label: string;
  cron: string;
  prompt: string;
  timezone?: string;
  once?: boolean;
}

export interface UserStore {
  dietary?: string;
  lists: Record<string, string[]>;
  gifts: Record<string, GiftEntry>;
  trips: Record<string, TripEntry>;
  recipes: Record<string, Recipe>;
  approved_emails: string[];
  schedules: ScheduleEntry[];
}

type AllStores = Record<string, UserStore>;

const DEFAULT_LISTS = ["groceries", "todos", "to buy"];

function loadAll(): AllStores {
  if (!existsSync(STORE_PATH)) return {};
  return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
}

function saveAll(all: AllStores): void {
  writeFileSync(STORE_PATH, JSON.stringify(all, null, 2));
}

function chatKey(ctx: UserContext): string {
  return String(ctx.chatId);
}

export function loadUserStore(ctx: UserContext): UserStore {
  const all = loadAll();
  const store = all[chatKey(ctx)];
  if (store) {
    // Ensure keys exist for stores created before newer features
    if (!store.trips) store.trips = {};
    if (!store.recipes) store.recipes = {};
    if (!store.approved_emails) store.approved_emails = [];
    if (!store.schedules) store.schedules = [];
    return store;
  }
  return {
    lists: Object.fromEntries(DEFAULT_LISTS.map((n) => [n, []])),
    gifts: {},
    trips: {},
    recipes: {},
    approved_emails: [],
    schedules: [],
  };
}

export function saveUserStore(ctx: UserContext, store: UserStore): void {
  const all = loadAll();
  all[chatKey(ctx)] = store;
  saveAll(all);
}
