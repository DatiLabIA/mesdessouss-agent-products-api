import { Router, type IRouter } from "express";
import { productSearch } from "../handlers/product-search";
import { sizeGuide } from "../handlers/size-guide";
import { storePolicies } from "../handlers/store-policies";
import { catalogOptions } from "../handlers/catalog-options";
import { orderLookup } from "../handlers/order-lookup";

export const mesdessousRouter: IRouter = Router();

mesdessousRouter.post("/product_search", productSearch);
mesdessousRouter.post("/size_guide", sizeGuide);
mesdessousRouter.post("/store_policies", storePolicies);
mesdessousRouter.post("/catalog_options", catalogOptions);
mesdessousRouter.post("/order_lookup", orderLookup);
