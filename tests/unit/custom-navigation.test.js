import { describe, expect, it } from "vitest";
import {
  CUSTOM_NAV_ITEMS,
  getCustomPageInfo,
} from "@/shared/constants/customNavigation";

describe("custom navigation registry", () => {
  it("keeps downstream navigation entries in their existing order", () => {
    expect(CUSTOM_NAV_ITEMS).toEqual([
      {
        href: "/dashboard/import-export",
        label: "Import / Export",
        icon: "import_export",
        description: "Transfer selected 9Router configuration items",
      },
      {
        href: "/dashboard/contributors",
        label: "Contributors",
        icon: "group_add",
        description: "Create and manage scoped OAuth contribution links",
      },
    ]);
  });

  it("resolves header metadata for custom routes", () => {
    expect(getCustomPageInfo("/dashboard/import-export")).toEqual({
      title: "Import / Export",
      description: "Transfer selected 9Router configuration items",
      icon: "import_export",
      breadcrumbs: [],
    });
    expect(getCustomPageInfo("/dashboard/contributors/invite")).toEqual({
      title: "Contributors",
      description: "Create and manage scoped OAuth contribution links",
      icon: "group_add",
      breadcrumbs: [],
    });
  });

  it("ignores upstream routes", () => {
    expect(getCustomPageInfo("/dashboard/providers")).toBeNull();
  });
});
