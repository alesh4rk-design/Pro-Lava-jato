// Cache em memória (por página) de serviços e categorias, para não repetir requisições.

import { api } from './api.js';

const cache = new Map();

function cached(key, path) {
  if (!cache.has(key)) {
    const promise = api.get(path).then((data) => data.items);
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return cache.get(key);
}

export const getServices = () => cached('services', '/services');
export const getCategories = (kind) => cached(`categories:${kind}`, `/categories?kind=${encodeURIComponent(kind)}`);
export const getProducts = () => cached('products', '/products');
export const invalidateCatalog = () => cache.clear();
