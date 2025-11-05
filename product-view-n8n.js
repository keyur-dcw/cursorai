/**
 * Product View – Epicor N8N Cart Flow Enhancements
 * Keeps the view/edit cart loader in sync with N8N processing
 */

(function() {
    'use strict';

    const DEFAULT_CART_URL = '/cart.php';
    const CART_LINK_SELECTOR = 'a[href*="cart.php"], a[href*="/cart/"]';

    const CART_FLOW_CONFIG = {
        maxWaitMs: 10000,
        minSpinnerMs: 400,
        postCompletionDelayMs: 2000,
        loaderFallbackMs: 15000,
        pollIntervalMs: 100
    };

    let loaderFallbackTimer = null;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    ensureN8NProcessingStatus();

    document.addEventListener('DOMContentLoaded', () => {
        moveProductOptionsIntoFormAction();
        handlePriceVisibilityByCustomField();
        setupAddToCartListener();
        setupDynamicAddToCartObserver();
        disableAutoCartRedirect();
    });

    document.addEventListener('click', (event) => {
        const link = event.target.closest(CART_LINK_SELECTOR);
        if (!link) {
            return;
        }

        if (!window.N8NProcessingStatus.inProgress) {
            return;
        }

        event.preventDefault();
        showLoaderForElement(link);

        waitForN8NCompletion({
            timeout: CART_FLOW_CONFIG.maxWaitMs,
            minWait: CART_FLOW_CONFIG.minSpinnerMs,
            pollInterval: CART_FLOW_CONFIG.pollIntervalMs
        }).then(async ({ completed, timedOut }) => {
            if (completed) {
                await sleep(CART_FLOW_CONFIG.postCompletionDelayMs);
            } else if (timedOut) {
                markN8NProcessingComplete();
            }

            stopBigCommerceLoader();

            const href = link.getAttribute('href');
            await sleep(100);
            window.location.href = href && href !== '#' ? href : DEFAULT_CART_URL;
        }).catch(() => {
            stopBigCommerceLoader();
            const href = link.getAttribute('href');
            window.location.href = href && href !== '#' ? href : DEFAULT_CART_URL;
        });
    });

    function ensureN8NProcessingStatus() {
        if (!window.N8NProcessingStatus) {
            window.N8NProcessingStatus = {
                inProgress: false,
                completed: false,
                completionTime: null
            };
        }
    }

    function moveProductOptionsIntoFormAction() {
        const addToCartButtons = document.querySelector('.add-to-cart-buttons');
        const formAction = addToCartButtons?.querySelector('.form-action');
        const rfqButton = document.querySelector('#rfqButton');
        const productOptions = document.querySelector('.productView-details.product-options');

        if (addToCartButtons && formAction) {
            if (productOptions) {
                formAction.insertAdjacentElement('afterend', productOptions);
            }
            if (rfqButton) {
                formAction.insertAdjacentElement('afterend', rfqButton);
            }
        }
    }

    function handlePriceVisibilityByCustomField() {
        try {
            const dataEl = document.getElementById('productCustomFields');
            if (!dataEl) {
                return;
            }

            const fields = JSON.parse(dataEl.textContent || '[]');
            let priceShow = false;

            if (Array.isArray(fields)) {
                for (const field of fields) {
                    if (field && field.name && field.value &&
                        String(field.name).toLowerCase() === 'show_price' &&
                        String(field.value).toLowerCase() === 'yes') {
                        priceShow = true;
                        break;
                    }
                }
            }

            const priceEl = document.querySelector('.productView-price');
            const atcWrapper = document.querySelector('#atcWrapper .form-action') || document.querySelector('#atcWrapper');
            const rfqButton = document.getElementById('rfqButton');

            if (!priceShow) {
                if (priceEl) priceEl.style.display = 'none';
                if (atcWrapper) atcWrapper.style.display = 'none';
                if (rfqButton) rfqButton.style.display = '';
            } else {
                if (priceEl) priceEl.style.display = '';
                if (atcWrapper) atcWrapper.style.display = '';
                if (rfqButton) rfqButton.style.display = 'none';
            }
        } catch (error) {
            const priceElFallback = document.querySelector('.productView-price');
            const atcWrapperFallback = document.getElementById('atcWrapper');
            const rfqButtonFallback = document.getElementById('rfqButton');
            if (priceElFallback) priceElFallback.style.display = 'none';
            if (atcWrapperFallback) atcWrapperFallback.style.display = 'none';
            if (rfqButtonFallback) rfqButtonFallback.style.display = '';
        }
    }

    function markN8NProcessingStart() {
        ensureN8NProcessingStatus();
        window.N8NProcessingStatus.inProgress = true;
        window.N8NProcessingStatus.completed = false;
        window.N8NProcessingStatus.completionTime = null;
    }

    function markN8NProcessingComplete() {
        ensureN8NProcessingStatus();
        window.N8NProcessingStatus.inProgress = false;
        window.N8NProcessingStatus.completed = true;
        window.N8NProcessingStatus.completionTime = new Date();
    }

    function waitForN8NCompletion(options = {}) {
        const normalized = typeof options === 'number' ? { timeout: options } : options;
        const {
            timeout = CART_FLOW_CONFIG.maxWaitMs,
            minWait = CART_FLOW_CONFIG.minSpinnerMs,
            pollInterval = CART_FLOW_CONFIG.pollIntervalMs
        } = normalized;

        return new Promise((resolve) => {
            const start = Date.now();
            const deadline = start + timeout;
            const earliestRelease = start + Math.max(0, minWait || 0);
            const interval = Math.max(25, pollInterval || 25);
            let settled = false;

            const settle = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve({
                    completed: Boolean(result?.completed),
                    timedOut: Boolean(result?.timedOut),
                    waitedMs: Date.now() - start
                });
            };

            const check = () => {
                const stillProcessing = Boolean(window.N8NProcessingStatus?.inProgress);
                const now = Date.now();

                if (!stillProcessing && now >= earliestRelease) {
                    settle({ completed: true, timedOut: false });
                    return;
                }

                if (now >= deadline) {
                    settle({ completed: !stillProcessing, timedOut: stillProcessing });
                    return;
                }

                setTimeout(check, interval);
            };

            check();
        });
    }

    function showLoaderForElement(element) {
        const modal = element?.closest('.modal');
        const loader = modal?.querySelector('.loadingOverlay') || document.querySelector('.loadingOverlay');

        if (!loader) {
            return;
        }

        loader.style.display = 'block';

        if (loaderFallbackTimer) {
            clearTimeout(loaderFallbackTimer);
        }

        loaderFallbackTimer = window.setTimeout(() => {
            stopBigCommerceLoader();
        }, CART_FLOW_CONFIG.loaderFallbackMs);
    }

    function setupAddToCartListener() {
        document.querySelectorAll('form[data-cart-item-add]').forEach(attachB2BListener);
    }

    function attachB2BListener(form) {
        if (!form || form.dataset.n8nListenerAttached === 'true') {
            return;
        }

        form.addEventListener('submit', () => {
            checkB2BAndUpdateCart(form);
        });

        form.dataset.n8nListenerAttached = 'true';
    }

    function setupDynamicAddToCartObserver() {
        if (window.N8NAddToCartObserver) {
            return;
        }

        window.N8NAddToCartObserver = new MutationObserver(() => {
            setupAddToCartListener();
        });

        window.N8NAddToCartObserver.observe(document.body, { childList: true, subtree: true });
    }

    function disableAutoCartRedirect() {
        window.redirectToCartOnAdd = false;

        if (window.stencilUtils?.hooks?.on && !window.__N8NCartRedirectHooked) {
            window.__N8NCartRedirectHooked = true;

            window.stencilUtils.hooks.on('cart-redirect', (event) => {
                if (event?.preventDefault) {
                    event.preventDefault();
                }
                return false;
            });
        }
    }

    async function checkB2BAndUpdateCart(form) {
        try {
            if (window.EpicorN8NPricing?.isB2BCustomer?.()) {
                markN8NProcessingStart();

                setTimeout(() => {
                    updateCartViaN8NAfterAdd(form);
                }, 2000);
            }
        } catch (error) {
            console.error('Error in B2B check:', error);
            markN8NProcessingComplete();
        }
    }

    async function updateCartViaN8NAfterAdd(form) {
        try {
            const productId = form.querySelector('input[name="product_id"]').value;
            const quantity = form.querySelector('input[name="qty[]"]')?.value ||
                form.querySelector('input[name="qty"]')?.value || 1;

            const skuElement = document.querySelector('[data-product-sku]');
            const sku = skuElement ? skuElement.textContent.trim() : '';

            if (!sku) {
                console.error('Product SKU not found');
                return;
            }

            const cartId = await getCartId();
            if (!cartId) {
                console.error('Cart ID not found');
                return;
            }

            let epicorPrice = null;
            if (window.EpicorN8NPricing?.getEpicorPriceForProduct) {
                epicorPrice = await window.EpicorN8NPricing.getEpicorPriceForProduct(productId, sku);
            }

            if (!epicorPrice) {
                return;
            }

            await updateCartPriceViaN8N(cartId, productId, sku, quantity, epicorPrice);
        } catch (error) {
            console.error('Error updating cart via N8N:', error);
        } finally {
            markN8NProcessingComplete();
        }
    }

    async function updateCartPriceViaN8N(cartId, productId, sku, quantity, epicorPrice) {
        try {
            const cartItemDetails = await getCartItemDetails(cartId, productId, sku);

            if (!cartItemDetails) {
                console.error('Cart item details not found');
                return false;
            }

            const n8nPayload = {
                action: 'update_cart_prices',
                cart_id: cartId,
                cart_item: {
                    item_id: cartItemDetails.id,
                    product_id: productId,
                    variant_id: cartItemDetails.variantId || cartItemDetails.variant_id,
                    sku,
                    name: cartItemDetails.name,
                    quantity,
                    epicor_price: epicorPrice
                },
                store_hash: '7eebdlwfu4',
                auth_token: 'pte9meprexvgw4td3ajlirxdsvk0e07'
            };

            const response = await fetch('https://cannon.n8n.asgard.dcw.dev/webhook/update-cart-price', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(n8nPayload)
            });

            if (!response.ok) {
                console.error(`N8N cart update failed: ${response.status} ${response.statusText}`);
                return false;
            }

            const data = await response.json();
            const success = data.success !== false;

            stopBigCommerceLoader();

            return success;
        } catch (error) {
            console.error('Error updating cart price via N8N:', error);
            stopBigCommerceLoader();
            return false;
        }
    }

    function stopBigCommerceLoader() {
        if (loaderFallbackTimer) {
            clearTimeout(loaderFallbackTimer);
            loaderFallbackTimer = null;
        }

        try {
            const loadingOverlay = document.querySelector('.loadingOverlay');
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
            }

            const modalLoaders = document.querySelectorAll('.modal .loadingOverlay');
            modalLoaders.forEach((loader) => {
                loader.style.display = 'none';
            });

            const modalContent = document.querySelector('.modal .modal-content');
            if (modalContent) {
                modalContent.style.display = 'block';
            }

            if (window.$?.fn?.reveal) {
                window.$('.modal').foundation('close');
            }

            const stopLoaderEvent = new CustomEvent('stopLoader');
            document.dispatchEvent(stopLoaderEvent);
        } catch (error) {
            console.error('Error stopping BigCommerce loader:', error);
        }
    }

    async function getCartId() {
        try {
            const response = await fetch('/api/storefront/cart');
            const data = await response.json();

            if (Array.isArray(data) && data.length > 0) {
                return data[0].id;
            }

            if (data && data.id) {
                return data.id;
            }
        } catch (error) {
            console.error('Error getting cart ID:', error);
        }

        return null;
    }

    async function getCartItemDetails(cartId, productId, sku) {
        try {
            const response = await fetch(`/api/storefront/checkouts/${cartId}`);
            if (!response.ok) {
                console.error('Failed to get checkout data:', response.status);
                return null;
            }

            const checkoutData = await response.json();

            let physicalItems = null;

            if (checkoutData.cart?.line_items?.physical_items) {
                physicalItems = checkoutData.cart.line_items.physical_items;
            } else if (checkoutData.cart?.lineItems?.physicalItems) {
                physicalItems = checkoutData.cart.lineItems.physicalItems;
            } else if (checkoutData.line_items?.physical_items) {
                physicalItems = checkoutData.line_items.physical_items;
            } else if (checkoutData.lineItems?.physicalItems) {
                physicalItems = checkoutData.lineItems.physicalItems;
            } else {
                console.error('Could not find physical_items in checkout data');
                return null;
            }

            if (!physicalItems || !Array.isArray(physicalItems)) {
                console.error('Physical items is not an array:', physicalItems);
                return null;
            }

            let matchingItem = null;
            let latestTime = 0;

            for (const item of physicalItems) {
                const itemProductId = item.productId || item.product_id;
                const itemSku = item.sku;

                if (itemProductId == productId && itemSku === sku) {
                    const itemTime = new Date(
                        item.createdTime ||
                        item.created_time ||
                        item.updatedTime ||
                        item.updated_time ||
                        Date.now()
                    ).getTime();

                    if (itemTime > latestTime) {
                        latestTime = itemTime;
                        matchingItem = item;
                    }
                }
            }

            if (matchingItem) {
                return matchingItem;
            }

            return await getCartItemDetailsFallback(productId, sku);
        } catch (error) {
            console.error('Error getting cart item details:', error);
            return null;
        }
    }

    async function getCartItemDetailsFallback(productId, sku) {
        try {
            const response = await fetch('/api/storefront/cart');
            if (!response.ok) {
                console.error('Failed to get cart data:', response.status);
                return null;
            }

            const cartData = await response.json();

            let items = null;

            if (Array.isArray(cartData)) {
                const cart = cartData[0];
                if (cart?.line_items?.physical_items) {
                    items = cart.line_items.physical_items;
                } else if (cart?.lineItems?.physicalItems) {
                    items = cart.lineItems.physicalItems;
                }
            } else if (cartData.line_items?.physical_items) {
                items = cartData.line_items.physical_items;
            } else if (cartData.lineItems?.physicalItems) {
                items = cartData.lineItems.physicalItems;
            } else if (cartData.items) {
                items = cartData.items;
            }

            if (!items || !Array.isArray(items)) {
                console.error('Could not find items in cart data');
                return null;
            }

            let matchingItem = null;
            let latestTime = 0;

            for (const item of items) {
                const itemProductId = item.productId || item.product_id;
                const itemSku = item.sku;

                if (itemProductId == productId && itemSku === sku) {
                    const itemTime = new Date(
                        item.createdTime ||
                        item.created_time ||
                        item.updatedTime ||
                        item.updated_time ||
                        Date.now()
                    ).getTime();

                    if (itemTime > latestTime) {
                        latestTime = itemTime;
                        matchingItem = item;
                    }
                }
            }

            if (matchingItem) {
                return matchingItem;
            }

            console.error('No matching cart item found via fallback for product:', productId, 'SKU:', sku);
            return null;
        } catch (error) {
            console.error('Error in fallback cart item lookup:', error);
            return null;
        }
    }
})();

