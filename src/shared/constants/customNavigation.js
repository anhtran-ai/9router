export const CUSTOM_NAV_ITEMS = [
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
];

export const getCustomPageInfo = (pathname) => {
  const item = CUSTOM_NAV_ITEMS.find(({ href }) => pathname?.startsWith(href));

  if (!item) return null;

  return {
    title: item.label,
    description: item.description,
    icon: item.icon,
    breadcrumbs: [],
  };
};
