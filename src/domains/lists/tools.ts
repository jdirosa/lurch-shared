import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../agent.js";
import type { UserContext } from "../../users.js";
import { loadUserStore, saveUserStore } from "../store.js";
import type { GiftEntry, Recipe } from "../store.js";

// --- Tool definitions ---

export const listsTools: Anthropic.Tool[] = [
  {
    name: "lists_view",
    description:
      "View all lists or a specific list. " +
      "If no name is provided, returns all list names and their item counts. " +
      "If a name is provided, returns all items in that list.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name of the list to view (e.g., 'groceries', 'todos'). Omit to see all lists.",
        },
      },
      required: [],
    },
  },
  {
    name: "lists_add",
    description:
      "Add one or more items to a named list. Creates the list if it doesn't exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name of the list (e.g., 'groceries', 'todos')",
        },
        items: {
          type: "array",
          items: { type: "string" },
          description: "Items to add to the list",
        },
      },
      required: ["name", "items"],
    },
  },
  {
    name: "lists_remove",
    description:
      "Remove one or more items from a named list by matching text (case-insensitive, partial match).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name of the list",
        },
        items: {
          type: "array",
          items: { type: "string" },
          description: "Items to remove (partial match, case-insensitive)",
        },
      },
      required: ["name", "items"],
    },
  },
  {
    name: "lists_clear",
    description: "Delete an entire list by name.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Name of the list to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "gifts_view",
    description:
      "View the gift tracker. " +
      "If no person is specified, returns all tracked people with their birthdays and number of gift ideas. " +
      "If a person is specified, returns their birthday and all gift ideas.",
    input_schema: {
      type: "object" as const,
      properties: {
        person: {
          type: "string",
          description: "Name of the person to view. Omit to see everyone.",
        },
      },
      required: [],
    },
  },
  {
    name: "gifts_set_birthday",
    description: "Set or update a person's birthday in the gift tracker.",
    input_schema: {
      type: "object" as const,
      properties: {
        person: {
          type: "string",
          description: "Name of the person",
        },
        birthday: {
          type: "string",
          description: "Birthday (e.g., 'March 15', '1990-03-15', 'Mar 15')",
        },
      },
      required: ["person", "birthday"],
    },
  },
  {
    name: "gifts_add_ideas",
    description:
      "Add gift ideas for a person. Creates the person entry if they don't exist yet.",
    input_schema: {
      type: "object" as const,
      properties: {
        person: {
          type: "string",
          description: "Name of the person",
        },
        ideas: {
          type: "array",
          items: { type: "string" },
          description: "Gift ideas to add",
        },
      },
      required: ["person", "ideas"],
    },
  },
  {
    name: "gifts_remove_ideas",
    description:
      "Remove gift ideas for a person by matching text (case-insensitive, partial match).",
    input_schema: {
      type: "object" as const,
      properties: {
        person: {
          type: "string",
          description: "Name of the person",
        },
        ideas: {
          type: "array",
          items: { type: "string" },
          description: "Ideas to remove (partial match, case-insensitive)",
        },
      },
      required: ["person", "ideas"],
    },
  },
  {
    name: "gifts_update_notes",
    description:
      "Update notes about a person — their interests, hobbies, relationship, " +
      "things to avoid, or anything useful for picking gifts. " +
      "Replaces existing notes entirely, so include everything relevant.",
    input_schema: {
      type: "object" as const,
      properties: {
        person: {
          type: "string",
          description: "Name of the person",
        },
        notes: {
          type: "string",
          description: "Free-text notes (interests, hobbies, relationship, avoid categories, etc.)",
        },
      },
      required: ["person", "notes"],
    },
  },
  {
    name: "gifts_remove_person",
    description: "Remove a person entirely from the gift tracker.",
    input_schema: {
      type: "object" as const,
      properties: {
        person: {
          type: "string",
          description: "Name of the person to remove",
        },
      },
      required: ["person"],
    },
  },
  {
    name: "recipes_save",
    description:
      "Save or update a recipe. Overwrites any existing recipe with the same name. " +
      "Ingredients and steps can be as detailed or as casual as the user wants — " +
      "'2 cups flour' and 'flour' are both fine. Steps are optional.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Recipe name (e.g., 'Chicken Tikka Masala', 'Mom\\'s Chili')",
        },
        ingredients: {
          type: "array",
          items: { type: "string" },
          description: "List of ingredients — any level of detail",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Preparation steps (optional — omit if user just wants ingredients)",
        },
        notes: {
          type: "string",
          description: "Free-text notes (dietary info, source URL, tweaks, etc.)",
        },
      },
      required: ["name", "ingredients"],
    },
  },
  {
    name: "recipes_view",
    description:
      "View saved recipes. If no name given, lists all recipe names. " +
      "If a name is given, shows the full recipe with ingredients, steps, and notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Recipe name to view. Omit to list all recipes.",
        },
      },
      required: [],
    },
  },
  {
    name: "recipes_delete",
    description: "Delete a saved recipe by name.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Recipe name to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "dietary_set",
    description:
      "Set or update the user's current dietary preferences/restrictions. " +
      "This is free-text — could be 'vegetarian', 'keto, no dairy', 'no red meat', etc. " +
      "Pass an empty string to clear. These preferences inform recipe suggestions and modifications.",
    input_schema: {
      type: "object" as const,
      properties: {
        dietary: {
          type: "string",
          description: "Dietary preferences/restrictions (empty string to clear)",
        },
      },
      required: ["dietary"],
    },
  },
  {
    name: "dietary_get",
    description: "Get the user's current dietary preferences/restrictions.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- List handlers ---

async function handleListsView(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const name = input.name ? String(input.name).toLowerCase() : undefined;

  if (!name) {
    const entries = Object.entries(store.lists);
    if (entries.length === 0) return "No lists yet.";
    return entries
      .map(([n, items]) => `${n} (${items.length} items)`)
      .join("\n");
  }

  const items = store.lists[name];
  if (!items) return `No list named "${name}".`;
  if (items.length === 0) return `"${name}" is empty.`;
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

async function handleListsAdd(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const name = String(input.name).toLowerCase();
  const items = input.items as string[];

  if (!store.lists[name]) store.lists[name] = [];
  store.lists[name].push(...items);
  saveUserStore(ctx, store);

  return `Added ${items.length} item${items.length === 1 ? "" : "s"} to "${name}" (${store.lists[name].length} total).`;
}

async function handleListsRemove(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const name = String(input.name).toLowerCase();
  const patterns = (input.items as string[]).map((s) => s.toLowerCase());

  if (!store.lists[name]) return `No list named "${name}".`;

  const before = store.lists[name].length;
  store.lists[name] = store.lists[name].filter(
    (item) => !patterns.some((p) => item.toLowerCase().includes(p))
  );
  const removed = before - store.lists[name].length;
  saveUserStore(ctx, store);

  return `Removed ${removed} item${removed === 1 ? "" : "s"} from "${name}" (${store.lists[name].length} remaining).`;
}

async function handleListsClear(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const name = String(input.name).toLowerCase();

  if (!store.lists[name]) return `No list named "${name}".`;

  delete store.lists[name];
  saveUserStore(ctx, store);

  return `Deleted list "${name}".`;
}

// --- Gift handlers ---

function findPerson(gifts: Record<string, GiftEntry>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(gifts).find((k) => k.toLowerCase() === lower);
}

async function handleGiftsView(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const personInput = input.person ? String(input.person) : undefined;

  if (!personInput) {
    const entries = Object.entries(store.gifts);
    if (entries.length === 0) return "No one in the gift tracker yet.";
    return entries
      .map(([name, entry]) => {
        const bday = entry.birthday ? ` (birthday: ${entry.birthday})` : "";
        return `${name}${bday} — ${entry.ideas.length} gift idea${entry.ideas.length === 1 ? "" : "s"}`;
      })
      .join("\n");
  }

  const key = findPerson(store.gifts, personInput);
  if (!key) return `No one named "${personInput}" in the gift tracker.`;

  const entry = store.gifts[key];
  const lines = [`${key}`];
  if (entry.birthday) lines.push(`Birthday: ${entry.birthday}`);
  if (entry.notes) lines.push(`Notes: ${entry.notes}`);
  if (entry.ideas.length === 0) {
    lines.push("No gift ideas yet.");
  } else {
    lines.push("Gift ideas:");
    entry.ideas.forEach((idea, i) => lines.push(`  ${i + 1}. ${idea}`));
  }
  return lines.join("\n");
}

async function handleGiftsSetBirthday(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const personInput = String(input.person);
  const birthday = String(input.birthday);

  const key = findPerson(store.gifts, personInput) ?? personInput;
  if (!store.gifts[key]) store.gifts[key] = { ideas: [] };
  store.gifts[key].birthday = birthday;
  saveUserStore(ctx, store);

  return `Set ${key}'s birthday to ${birthday}.`;
}

async function handleGiftsAddIdeas(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const personInput = String(input.person);
  const ideas = input.ideas as string[];

  const key = findPerson(store.gifts, personInput) ?? personInput;
  if (!store.gifts[key]) store.gifts[key] = { ideas: [] };
  store.gifts[key].ideas.push(...ideas);
  saveUserStore(ctx, store);

  return `Added ${ideas.length} idea${ideas.length === 1 ? "" : "s"} for ${key} (${store.gifts[key].ideas.length} total).`;
}

async function handleGiftsRemoveIdeas(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const personInput = String(input.person);
  const patterns = (input.ideas as string[]).map((s) => s.toLowerCase());

  const key = findPerson(store.gifts, personInput);
  if (!key) return `No one named "${personInput}" in the gift tracker.`;

  const before = store.gifts[key].ideas.length;
  store.gifts[key].ideas = store.gifts[key].ideas.filter(
    (idea) => !patterns.some((p) => idea.toLowerCase().includes(p))
  );
  const removed = before - store.gifts[key].ideas.length;
  saveUserStore(ctx, store);

  return `Removed ${removed} idea${removed === 1 ? "" : "s"} for ${key} (${store.gifts[key].ideas.length} remaining).`;
}

async function handleGiftsUpdateNotes(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const personInput = String(input.person);
  const notes = String(input.notes);

  const key = findPerson(store.gifts, personInput) ?? personInput;
  if (!store.gifts[key]) store.gifts[key] = { ideas: [] };
  store.gifts[key].notes = notes;
  saveUserStore(ctx, store);

  return `Updated notes for ${key}.`;
}

async function handleGiftsRemovePerson(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const personInput = String(input.person);

  const key = findPerson(store.gifts, personInput);
  if (!key) return `No one named "${personInput}" in the gift tracker.`;

  delete store.gifts[key];
  saveUserStore(ctx, store);

  return `Removed ${key} from the gift tracker.`;
}

// --- Recipe handlers ---

function findRecipe(recipes: Record<string, Recipe>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(recipes).find((k) => k.toLowerCase() === lower);
}

async function handleRecipesSave(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const name = String(input.name);
  const ingredients = input.ingredients as string[];
  const steps = input.steps as string[] | undefined;
  const notes = input.notes ? String(input.notes) : undefined;

  const key = findRecipe(store.recipes, name) ?? name;
  store.recipes[key] = { name: key, ingredients, steps, notes };
  saveUserStore(ctx, store);

  return `Saved recipe "${key}" (${ingredients.length} ingredients${steps ? `, ${steps.length} steps` : ""}).`;
}

async function handleRecipesView(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const nameInput = input.name ? String(input.name) : undefined;

  if (!nameInput) {
    const names = Object.keys(store.recipes);
    if (names.length === 0) return "No saved recipes yet.";
    return names.map((n) => {
      const r = store.recipes[n];
      const note = r.notes ? ` — ${r.notes}` : "";
      return `${n} (${r.ingredients.length} ingredients)${note}`;
    }).join("\n");
  }

  const key = findRecipe(store.recipes, nameInput);
  if (!key) return `No recipe named "${nameInput}".`;

  const r = store.recipes[key];
  const lines = [r.name];
  if (r.notes) lines.push(`Notes: ${r.notes}`);
  lines.push("", "Ingredients:");
  r.ingredients.forEach((ing) => lines.push(`  - ${ing}`));
  if (r.steps && r.steps.length > 0) {
    lines.push("", "Steps:");
    r.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  }
  return lines.join("\n");
}

async function handleRecipesDelete(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const key = findRecipe(store.recipes, String(input.name));
  if (!key) return `No recipe named "${input.name}".`;

  delete store.recipes[key];
  saveUserStore(ctx, store);
  return `Deleted recipe "${key}".`;
}

// --- Dietary handlers ---

async function handleDietarySet(
  input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  const value = String(input.dietary).trim();
  if (value) {
    store.dietary = value;
    saveUserStore(ctx, store);
    return `Dietary preferences set to: ${value}`;
  } else {
    delete store.dietary;
    saveUserStore(ctx, store);
    return "Dietary preferences cleared.";
  }
}

async function handleDietaryGet(
  _input: Record<string, unknown>,
  ctx: UserContext
): Promise<string> {
  const store = loadUserStore(ctx);
  return store.dietary
    ? `Current dietary preferences: ${store.dietary}`
    : "No dietary preferences set.";
}

export const listsHandlers = new Map<string, ToolHandler>([
  ["lists_view", handleListsView],
  ["lists_add", handleListsAdd],
  ["lists_remove", handleListsRemove],
  ["lists_clear", handleListsClear],
  ["gifts_view", handleGiftsView],
  ["gifts_set_birthday", handleGiftsSetBirthday],
  ["gifts_add_ideas", handleGiftsAddIdeas],
  ["gifts_remove_ideas", handleGiftsRemoveIdeas],
  ["gifts_update_notes", handleGiftsUpdateNotes],
  ["gifts_remove_person", handleGiftsRemovePerson],
  ["recipes_save", handleRecipesSave],
  ["recipes_view", handleRecipesView],
  ["recipes_delete", handleRecipesDelete],
  ["dietary_set", handleDietarySet],
  ["dietary_get", handleDietaryGet],
]);
