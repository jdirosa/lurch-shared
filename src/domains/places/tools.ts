import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../agent.js";
import { config } from "../../config.js";
import { log } from "../../log.js";

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.shortFormattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.regularOpeningHours",
  "places.priceLevel",
  "places.websiteUri",
  "places.googleMapsUri",
].join(",");

// Minimal field mask for geocoding a reference point
const GEOCODE_MASK = "places.location,places.displayName,places.formattedAddress";

interface PlaceResult {
  displayName?: { text: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { openNow?: boolean; weekdayDescriptions?: string[] };
  priceLevel?: string;
  websiteUri?: string;
  googleMapsUri?: string;
}

function haversineMeters(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

function formatPlace(place: PlaceResult, i: number, refCoords?: { latitude: number; longitude: number }): string {
  const lines = [`${i + 1}. ${place.displayName?.text ?? "(unnamed)"}`];
  if (place.shortFormattedAddress) {
    lines.push(`   Address: ${place.shortFormattedAddress}`);
  } else if (place.formattedAddress) {
    lines.push(`   Address: ${place.formattedAddress}`);
  }
  if (refCoords && place.location) {
    const dist = haversineMeters(refCoords.latitude, refCoords.longitude, place.location.latitude, place.location.longitude);
    lines.push(`   Distance: ${formatDistance(dist)}`);
  }
  if (place.rating != null) {
    const count = place.userRatingCount ? ` (${place.userRatingCount} reviews)` : "";
    lines.push(`   Rating: ${place.rating}/5${count}`);
  }
  if (place.priceLevel) {
    const level = place.priceLevel.replace("PRICE_LEVEL_", "").toLowerCase();
    lines.push(`   Price: ${level}`);
  }
  if (place.regularOpeningHours?.openNow != null) {
    lines.push(`   Open now: ${place.regularOpeningHours.openNow ? "yes" : "no"}`);
  }
  if (place.websiteUri) lines.push(`   Website: ${place.websiteUri}`);
  if (place.googleMapsUri) lines.push(`   Maps: ${place.googleMapsUri}`);
  return lines.join("\n");
}

async function geocode(landmark: string): Promise<{ latitude: number; longitude: number } | null> {
  if (!config.googlePlacesApiKey) return null;

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.googlePlacesApiKey,
      "X-Goog-FieldMask": GEOCODE_MASK,
    },
    body: JSON.stringify({ textQuery: landmark, pageSize: 1 }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const place = (data.places ?? [])[0] as PlaceResult | undefined;
  if (!place?.location) return null;

  log(`[places] geocoded "${landmark}" → ${place.displayName?.text} (${place.location.latitude}, ${place.location.longitude})`);
  return place.location;
}

export const placesTools: Anthropic.Tool[] = [
  {
    name: "places_search",
    description:
      "Search for places using Google Places API. Returns detailed, block-level results " +
      "including name, exact address, rating, price level, hours, distance, and Google Maps link. " +
      "Use for finding restaurants, bars, shops, services, attractions, etc. " +
      "For precise location searches, use the 'near' param with a landmark or address and " +
      "set a tight radius — results will be sorted by distance and only include places within that radius. " +
      "Examples: query='bars' near='Greektown Casino, Detroit' radius=200 (across the street), " +
      "query='coffee shops' near='Union Station, Toronto' radius=500 (walking distance).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "What to search for (e.g., 'bars', 'coffee shops', 'pharmacies'). " +
            "If not using 'near', include the location in the query (e.g., 'bars in downtown Detroit').",
        },
        near: {
          type: "string",
          description:
            "Landmark, address, or place name to center the search on. " +
            "When set, results are restricted to the given radius and sorted by distance. " +
            "Examples: 'Greektown Casino, Detroit', '123 Main St, Toronto', 'CN Tower'.",
        },
        radius: {
          type: "number",
          description:
            "Search radius in meters (only used with 'near'). " +
            "Default: 1000 (walking distance). Use 100-200 for 'across the street', " +
            "500-1000 for walking distance, 1500-3000 for nearby neighborhood.",
        },
        open_now: {
          type: "boolean",
          description: "Only return places that are currently open (default: false)",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 10, max: 20)",
        },
      },
      required: ["query"],
    },
  },
];

async function handlePlacesSearch(
  input: Record<string, unknown>,
): Promise<string> {
  if (!config.googlePlacesApiKey) {
    return "Google Places API key not configured.";
  }

  const query = String(input.query);
  const near = input.near ? String(input.near) : undefined;
  const radius = Number(input.radius) || 1000;
  const openNow = input.open_now === true;
  const maxResults = Math.min(Number(input.max_results) || 10, 20);

  // If 'near' is specified, geocode the reference point
  let refCoords: { latitude: number; longitude: number } | null = null;
  if (near) {
    refCoords = await geocode(near);
    if (!refCoords) {
      return `Could not find location "${near}". Try a more specific address or landmark.`;
    }
  }

  const body: Record<string, unknown> = {
    textQuery: near ? `${query} near ${near}` : query,
    pageSize: maxResults,
    languageCode: "en",
  };
  if (openNow) body.openNow = true;

  // When we have coords, restrict search to the specified radius
  if (refCoords) {
    body.locationBias = {
      circle: {
        center: refCoords,
        radius,
      },
    };
  }

  log(`[places] searching: "${body.textQuery}" (near=${near ?? "none"}, radius=${radius}m, open_now=${openNow}, max=${maxResults})`);

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.googlePlacesApiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    log(`[places] error ${res.status}: ${text}`);
    return `Places API error (${res.status}): ${text}`;
  }

  const data = await res.json();
  let places = (data.places ?? []) as PlaceResult[];

  if (places.length === 0) {
    return `No results found for "${query}"${near ? ` near ${near}` : ""}.`;
  }

  // When searching near a reference point, filter to radius and sort by distance
  if (refCoords) {
    places = places
      .map((p) => ({
        place: p,
        dist: p.location
          ? haversineMeters(refCoords.latitude, refCoords.longitude, p.location.latitude, p.location.longitude)
          : Infinity,
      }))
      .filter((p) => p.dist <= radius)
      .sort((a, b) => a.dist - b.dist)
      .map((p) => p.place);

    if (places.length === 0) {
      return `No results found for "${query}" within ${formatDistance(radius)} of ${near}.`;
    }
  }

  const header = refCoords
    ? `Found ${places.length} result${places.length === 1 ? "" : "s"} for "${query}" within ${formatDistance(radius)} of ${near}:`
    : `Found ${places.length} result${places.length === 1 ? "" : "s"}:`;

  return header + "\n\n" + places.map((p, i) => formatPlace(p, i, refCoords ?? undefined)).join("\n\n");
}

export const placesHandlers = new Map<string, ToolHandler>([
  ["places_search", async (input) => handlePlacesSearch(input)],
]);
