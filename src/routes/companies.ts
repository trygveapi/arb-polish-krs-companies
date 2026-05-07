import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../lib/db";

const CompanySchema = z
  .object({
    krs_number: z.string().openapi({
      description:
        "10-digit KRS registry number assigned by the National Court Register. Stable primary key.",
      example: "0000123456",
    }),
    name: z.string().openapi({
      description: "Official registered legal name of the entity.",
      example: "Acme Polska sp. z o.o.",
    }),
    nip: z.string().nullable().openapi({
      description: "Polish tax identification number (10 digits).",
      example: "5252345678",
    }),
    regon: z.string().nullable().openapi({
      description: "Polish statistical identification number (9 or 14 digits).",
      example: "123456789",
    }),
    legal_form: z.string().nullable().openapi({
      description:
        "Legal form of the entity (e.g. spółka z o.o., spółka akcyjna).",
      example: "spółka z ograniczoną odpowiedzialnością",
    }),
    registry_type: z.enum(["P", "S", "U"]).openapi({
      description:
        "KRS register section: P (entrepreneurs), S (associations), or U (insolvent debtors).",
      example: "P",
    }),
    registration_date: z.string().nullable().openapi({
      description: "ISO 8601 date the entity was first entered into the KRS.",
      example: "2015-03-21",
    }),
    address: z.string().nullable().openapi({
      description:
        "Registered seat address as a single formatted string (street, postal code, city, voivodeship).",
      example: "ul. Marszałkowska 1, 00-001 Warszawa, mazowieckie",
    }),
    status: z.enum(["active", "in_liquidation", "bankrupt", "deleted"]).openapi({
      description: "Current status of the entity.",
      example: "active",
    }),
    last_entry_date: z.string().nullable().openapi({
      description:
        "ISO 8601 date of the most recent entry/amendment in the registry.",
      example: "2024-11-04",
    }),
  })
  .openapi("Company");

type Company = z.infer<typeof CompanySchema>;

const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "not_found" }),
      message: z.string().openapi({ example: "Resource not found" }),
    }),
  })
  .openapi("Error");

const ListResponseSchema = z
  .object({
    data: z.array(CompanySchema),
    pagination: z.object({
      next_cursor: z.string().nullable().openapi({
        description:
          "Pass as `cursor` on the next request to fetch the following page. Null when there are no more results.",
        example: "0000123456",
      }),
      limit: z.number().int().openapi({ example: 25 }),
    }),
  })
  .openapi("CompanyListResponse");

const ListQuerySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: "name", in: "query" },
      description: "Case-insensitive substring match on the registered name.",
      example: "Acme",
    }),
  nip: z
    .string()
    .regex(/^\d{10}$/)
    .optional()
    .openapi({
      param: { name: "nip", in: "query" },
      description: "Exact match on Polish tax identification number.",
      example: "5252345678",
    }),
  regon: z
    .string()
    .regex(/^\d{9}(\d{5})?$/)
    .optional()
    .openapi({
      param: { name: "regon", in: "query" },
      description: "Exact match on REGON (9 or 14 digits).",
      example: "123456789",
    }),
  registry_type: z
    .enum(["P", "S", "U"])
    .optional()
    .openapi({
      param: { name: "registry_type", in: "query" },
      description: "Filter by KRS register section.",
    }),
  status: z
    .enum(["active", "in_liquidation", "bankrupt", "deleted"])
    .optional()
    .openapi({
      param: { name: "status", in: "query" },
      description: "Filter by current status.",
    }),
  cursor: z
    .string()
    .regex(/^\d{10}$/)
    .optional()
    .openapi({
      param: { name: "cursor", in: "query" },
      description:
        "Opaque pagination cursor — the krs_number of the last record from the previous page.",
      example: "0000123456",
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .openapi({
      param: { name: "limit", in: "query" },
      description: "Number of records per page (max 100, default 25).",
      example: 25,
    }),
});

const IdParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d{10}$/)
    .openapi({
      param: { name: "id", in: "path" },
      description: "10-digit KRS number.",
      example: "0000123456",
    }),
});

const RateLimitResponse = {
  description: "Too many requests — rate limit exceeded.",
  content: {
    "application/json": {
      schema: ErrorSchema,
    },
  },
} as const;

const NotFoundResponse = {
  description: "Resource not found.",
  content: {
    "application/json": {
      schema: ErrorSchema,
    },
  },
} as const;

const listCompaniesRoute = createRoute({
  method: "get",
  path: "/v1/companies",
  tags: ["Companies"],
  summary:
    "List and filter Polish KRS-registered entities by name, NIP, REGON, registry type, or status with pagination.",
  request: {
    query: ListQuerySchema,
  },
  responses: {
    200: {
      description: "A paginated list of companies.",
      content: {
        "application/json": {
          schema: ListResponseSchema,
        },
      },
    },
    404: NotFoundResponse,
    429: RateLimitResponse,
  },
});

const getCompanyRoute = createRoute({
  method: "get",
  path: "/v1/companies/{id}",
  tags: ["Companies"],
  summary: "Retrieve a single company record by its 10-digit KRS number.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "The requested company record.",
      content: {
        "application/json": {
          schema: CompanySchema,
        },
      },
    },
    404: NotFoundResponse,
    429: RateLimitResponse,
  },
});

export function registerCompaniesRoutes(
  app: OpenAPIHono<{ Bindings: Env }>,
): void {
  app.openapi(listCompaniesRoute, async (c) => {
    const { name, nip, regon, registry_type, status, cursor, limit } =
      c.req.valid("query");

    const where: string[] = [];
    const binds: Array<string | number> = [];

    if (name) {
      where.push("name LIKE ?");
      binds.push(`%${name}%`);
    }
    if (nip) {
      where.push("nip = ?");
      binds.push(nip);
    }
    if (regon) {
      where.push("regon = ?");
      binds.push(regon);
    }
    if (registry_type) {
      where.push("registry_type = ?");
      binds.push(registry_type);
    }
    if (status) {
      where.push("status = ?");
      binds.push(status);
    }
    if (cursor) {
      where.push("krs_number > ?");
      binds.push(cursor);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT krs_number, name, nip, regon, legal_form, registry_type, registration_date, address, status, last_entry_date
                 FROM companies
                 ${whereClause}
                 ORDER BY krs_number ASC
                 LIMIT ?`;
    binds.push(limit + 1);

    const stmt = c.env.DB.prepare(sql).bind(...binds);
    const result = await stmt.all<Company>();
    const rows = result.results ?? [];

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const next_cursor =
      hasMore && data.length > 0 ? data[data.length - 1].krs_number : null;

    return c.json(
      {
        data,
        pagination: {
          next_cursor,
          limit,
        },
      },
      200,
    );
  });

  app.openapi(getCompanyRoute, async (c) => {
    const { id } = c.req.valid("param");

    const row = await c.env.DB.prepare(
      `SELECT krs_number, name, nip, regon, legal_form, registry_type, registration_date, address, status, last_entry_date
       FROM companies
       WHERE krs_number = ?
       LIMIT 1`,
    )
      .bind(id)
      .first<Company>();

    if (!row) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: `No company found with krs_number '${id}'.`,
          },
        },
        404,
      );
    }

    return c.json(row, 200);
  });
}