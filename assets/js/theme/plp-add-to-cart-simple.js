/**
 * Simple PLP Add to Cart Modal functionality (no jQuery dependency)
 * Optimised to use the default BigCommerce loader, minimise duplicate logic,
 * and provide faster feedback on PLP add-to-cart interactions.
 */
(function () {
    'use strict';

    const CONFIG = {
        minLoaderDuration: 500,
        cartPollAttempts: 6,
        cartPollInterval: 600,
        cartPollAttemptsOnRedirect: 10,
        n8nWaitBeforeCart: 2000,
        fallbackImage: 'https://via.placeholder.com/400x300?text=Product+Image',
        maxLoaderDuration: 2000,
        viewCartPostPricingLoaderDuration: 5000,
        viewCartPostLoaderDelay: 2000,
    };

    const SELECTORS = {
        modal: '#plpPreviewModal',
        modalContent: '.modal-content',
        addToCartButton: '[data-button-type="add-cart"]',
        modalClose: '.modal-close',
        otherModal: '.modal:not(#plpPreviewModal), .reveal:not(#plpPreviewModal), .dropdown-menu',
        quantityInput: '.qty-wrap input, .form-input--incrementTotal',
        card: '.card, .listItem',
        productTitle: '.card-title, .listItem-title, h4, h3, .product-title',
        productSku: '[data-product-sku], .card-sku, .listItem-sku',
        modalContinue: '.js-plp-modal-continue',
        modalViewCart: '.js-plp-modal-view-cart',
        cartCounters: '.cart-quantity, .cart-count, [data-cart-quantity], .header-cart .count, .cart-link .count, .cart-icon .count, .navUser-item--cart .count',
    };

    const state = {
        lastClickedButton: null,
        currentCartTotal: 0,
        baselineCartQuantity: 0,
        pendingPricingUpdate: Promise.resolve(),
        modalDismissed: false,
        lastAddedQuantity: 1,
    };

    waitForDOMReady(init);

    function waitForDOMReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
        } else {
            callback();
        }
    }

    function init() {
        const modal = document.querySelector(SELECTORS.modal);
        if (!modal) {
            return;
        }

        state.currentCartTotal = initializeCartTotalTracking();
        bindGlobalListeners();
    }

    function bindGlobalListeners() {
        document.addEventListener('click', handleDocumentClick, true);
        document.addEventListener('keydown', handleEscapeKey, true);
    }

    function handleDocumentClick(event) {
        const target = event.target;
        if (!target) return;

        const closeTrigger = target.closest(SELECTORS.modalClose);
        if (closeTrigger) {
            event.preventDefault();
            closeModal();
            return;
        }

        const addToCartButton = target.closest(SELECTORS.addToCartButton);
        if (addToCartButton) {
            handleAddToCartClick(event, addToCartButton);
            return;
        }

        const continueButton = target.closest(SELECTORS.modalContinue);
        if (continueButton) {
            event.preventDefault();
            closeModal();
            return;
        }

        const viewCartButton = target.closest(SELECTORS.modalViewCart);
        if (viewCartButton) {
            event.preventDefault();
            handleViewCartAction().catch((error) => {
                console.error('[simplePLPModal] View cart handler error', error);
                window.location.href = '/cart.php';
            });
        }
    }

    function handleEscapeKey(event) {
        if (event.key !== 'Escape') return;
        const modal = document.querySelector(SELECTORS.modal);
        if (modal && modal.style.display !== 'none') {
            closeModal();
        }
    }

    const modalLoader = (() => {
        let active = false;
        let startAt = 0;
        let mode = null; // 'modal' | 'existingOverlay' | 'fallbackOverlay'
        let overlayRef = null;
        let fallbackRef = null;

        function show() {
            const modal = document.querySelector(SELECTORS.modal);
            if (!modal) {
                showFallbackOverlay();
                return;
            }

            const modalContent = modal.querySelector(SELECTORS.modalContent);
            if (!modalContent) {
                showFallbackOverlay();
                return;
            }

            modalContent.innerHTML = getLoaderMarkup();
            openModal(modal);
            active = true;
            startAt = Date.now();
            mode = 'modal';
            overlayRef = null;
            fallbackRef = null;
        }

        function ensureVisible() {
            if (!active) {
                show();
            }
        }

        async function ensureMinimumDisplay(forceMinimum = true) {
            if (!active) return;

            if (forceMinimum) {
                const elapsed = Date.now() - startAt;
                const remaining = CONFIG.minLoaderDuration - elapsed;
                if (remaining > 0) {
                    await delay(remaining);
                }
            }

            if (mode === 'existingOverlay' && overlayRef) {
                overlayRef.style.display = 'none';
                overlayRef.setAttribute('aria-hidden', 'true');
                overlayRef.classList.remove('is-active', 'is-visible');
            }

            if (mode === 'fallbackOverlay' && fallbackRef) {
                fallbackRef.remove();
                fallbackRef = null;
            }

            active = false;
            mode = null;
            overlayRef = null;
        }

        function getLoaderMarkup() {
            return `
                <div class="modal-body modal-body--loading" aria-live="polite" aria-busy="true" style="display:flex;align-items:center;justify-content:center;min-height:180px;">
                    <div class="loadingOverlay is-active" data-loading-overlay data-loader-source="simple-plp" style="position:static;display:flex;align-items:center;justify-content:center;">
                        <div class="loadingOverlay-icon"></div>
                    </div>
                </div>
            `;
        }

        function showFallbackOverlay() {
            const overlay = document.querySelector('[data-loading-overlay]') || document.querySelector('.loadingOverlay');
            if (overlay) {
                overlay.style.display = 'block';
                overlay.setAttribute('aria-hidden', 'false');
                overlay.classList.add('is-active', 'is-visible');
                active = true;
                startAt = Date.now();
                mode = 'existingOverlay';
                overlayRef = overlay;
                fallbackRef = null;
                return;
            }

            const fallback = document.createElement('div');
            fallback.className = 'loadingOverlay loadingOverlay--simplePLP is-active';
            fallback.setAttribute('data-loading-overlay', '');
            fallback.setAttribute('data-loader-source', 'simple-plp');
            fallback.innerHTML = '<div class="loadingOverlay-icon"></div>';
            Object.assign(fallback.style, {
                position: 'fixed',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                background: 'rgba(255,255,255,0.8)',
                zIndex: '1001',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            });
            document.body.appendChild(fallback);
            active = true;
            startAt = Date.now();
            mode = 'fallbackOverlay';
            fallbackRef = fallback;
            overlayRef = null;
        }

        return {
            show,
            ensureVisible,
            ensureMinimumDisplay,
        };
    })();

    async function handleAddToCartClick(event, button) {
        if (!event || !button) return;
        if (button.dataset.plpProcessing === 'true') {
            event.preventDefault();
            return;
        }

        if (event.target && typeof event.target.closest === 'function') {
            if (event.target.closest(SELECTORS.otherModal)) {
                return;
            }
        }

        event.preventDefault();
        event.stopPropagation();

        const context = getProductContext(button);
        if (!context) {
            return;
        }

        state.lastClickedButton = button;
        state.baselineCartQuantity = state.currentCartTotal;
        state.lastAddedQuantity = context.quantity;
        const expectedQuantity = state.baselineCartQuantity + context.quantity;

        const buttonSnapshot = setButtonLoadingState(button);
        button.dataset.plpProcessing = 'true';

        try {
            state.modalDismissed = false;
            modalLoader.show();

            await addToCart(context.productId, context.quantity);

            incrementCartCounter(context.quantity);

            const pricingPromise = Promise.resolve(
                checkB2BAndUpdateCart(context.productId, context.quantity, button)
            );

            state.pendingPricingUpdate = pricingPromise
                .catch((error) => {
                    console.warn('[simplePLPModal] Pricing update error', error);
                    return null;
                })
                .finally(() => {
                    state.pendingPricingUpdate = Promise.resolve();
                });

            const cartDataPromise = waitForCartUpdate(expectedQuantity).catch(() => null);
            const loaderResult = await Promise.race([
                cartDataPromise.then((data) => ({ type: 'data', data })),
                delay(CONFIG.maxLoaderDuration).then(() => ({ type: 'timeout' })),
            ]);

            let cartData = null;
            const timedOut = loaderResult.type === 'timeout' || !loaderResult.data;
            if (!timedOut) {
                cartData = loaderResult.data;
            }

            await modalLoader.ensureMinimumDisplay(true);

            if (cartData) {
                updateCartCounter(cartData.quantity);
                showCartModalWithData(cartData);
            } else {
                if (!state.modalDismissed) {
                    showBasicSuccessModal();
                    cartDataPromise.then((data) => {
                        if (!state.modalDismissed && data && data.quantity >= 0) {
                            updateCartCounter(data.quantity);
                            showCartModalWithData(data);
                        }
                    });
                }
            }
        } catch (error) {
            console.error('[simplePLPModal] add to cart failed', error);
            await modalLoader.ensureMinimumDisplay(true);
            showAddToCartError();
        } finally {
            restoreButtonState(button, buttonSnapshot);
            delete button.dataset.plpProcessing;
        }
    }

    function getProductContext(button) {
        const card = button.closest(SELECTORS.card);
        if (!card) return null;

        const productId = button.getAttribute('data-product-id') || card.getAttribute('data-entity-id');
        if (!productId) return null;

        const qtyInput = card.querySelector(SELECTORS.quantityInput);
        let quantity = qtyInput ? parseInt(qtyInput.value, 10) : 1;
        if (!Number.isFinite(quantity) || quantity < 1) {
            quantity = 1;
        }

        return { productId, quantity, card };
    }
    function setButtonLoadingState(button) {
        const snapshot = {
            html: button.innerHTML,
            disabled: button.disabled,
            minWidth: button.style.minWidth || '',
        };

        const width = button.getBoundingClientRect().width;
        if (width) {
            button.style.minWidth = `${Math.ceil(width)}px`;
        }
        button.innerHTML = 'Adding...';
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        return snapshot;
    }

    function restoreButtonState(button, snapshot) {
        if (!snapshot) return;
        button.innerHTML = snapshot.html;
        button.disabled = snapshot.disabled;
        button.style.minWidth = snapshot.minWidth;
        button.removeAttribute('aria-busy');
    }

    async function addToCart(productId, quantity) {
        const payload = new URLSearchParams({
            action: 'add',
            product_id: productId,
            qty: quantity,
        });

        const response = await fetch('/cart.php', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            credentials: 'same-origin',
            body: payload.toString(),
        });

        if (!response.ok) {
            throw new Error(`Add to cart failed with status ${response.status}`);
        }
    }

    function incrementCartCounter(addedQuantity) {
        if (!Number.isFinite(addedQuantity) || addedQuantity < 1) {
            return;
        }

        state.currentCartTotal = (state.currentCartTotal || 0) + addedQuantity;
        updateDisplayedCartCounters(state.currentCartTotal);
    }

    function updateCartCounter(quantity) {
        const validQuantity = Math.max(0, parseInt(quantity, 10) || 0);
        state.currentCartTotal = Math.max(state.currentCartTotal || 0, validQuantity);
        updateDisplayedCartCounters(state.currentCartTotal);
    }

    function updateDisplayedCartCounters(quantity) {
        const counters = document.querySelectorAll(SELECTORS.cartCounters);
        counters.forEach((counter) => {
            const stored = parseInt(counter.getAttribute('data-current-quantity') || '0', 10);
            const displayed = parseInt(counter.textContent.replace(/\D/g, ''), 10) || 0;
            const finalCount = Math.max(quantity, stored, displayed);

            counter.textContent = finalCount;
            counter.setAttribute('data-current-quantity', finalCount);
            counter.classList.add('cart-count--positive');
        });

        const eventDetail = state.currentCartTotal || quantity;
        const updateEvent = new CustomEvent('cart-quantity-update', { detail: eventDetail });
        document.body.dispatchEvent(updateEvent);

        window.currentCartTotal = state.currentCartTotal;
    }

    async function waitForCartUpdate(expectedQuantity) {
        if (!Number.isFinite(expectedQuantity) || expectedQuantity < 0) {
            expectedQuantity = state.currentCartTotal || 0;
        }

        let latestData = null;
        for (let attempt = 0; attempt < CONFIG.cartPollAttempts; attempt += 1) {
            latestData = await getCartDataFromAPI().catch(() => null);
            if (latestData && latestData.quantity >= expectedQuantity) {
                return latestData;
            }
            await delay(CONFIG.cartPollInterval);
        }

        const fallbackData = getCartDataFromPage();
        if (fallbackData.quantity >= expectedQuantity) {
            return fallbackData;
        }

        return null;
    }

    async function redirectToCartAfterSync(expectedQuantity) {
        modalLoader.ensureVisible();
        const postPricingStart = Date.now();

        for (let attempt = 0; attempt < CONFIG.cartPollAttemptsOnRedirect; attempt += 1) {
            const cartData = await getCartDataFromAPI().catch(() => null);
            if (cartData && cartData.quantity >= expectedQuantity) {
                break;
            }
            await delay(CONFIG.cartPollInterval);
        }

        const elapsed = Date.now() - postPricingStart;
        const remaining = Math.max(0, CONFIG.viewCartPostPricingLoaderDuration - elapsed);
        if (remaining > 0) {
            await delay(remaining);
        }

        await modalLoader.ensureMinimumDisplay(false).catch(() => {});
        await delay(CONFIG.viewCartPostLoaderDelay);
        window.location.href = '/cart.php';
    }

    function getLastAddedProductInfo() {
        const button = state.lastClickedButton || window.lastClickedAddToCartButton;
        if (!button) {
            return {
                image: CONFIG.fallbackImage,
                name: 'Product Added to Cart',
                sku: '',
            };
        }

        const card = button.closest(SELECTORS.card);
        if (!card) {
            return {
                image: CONFIG.fallbackImage,
                name: 'Product Added to Cart',
                sku: '',
            };
        }

        const imageElement = card.querySelector('img');
        const titleElement = card.querySelector(SELECTORS.productTitle);
        const skuElement = card.querySelector(SELECTORS.productSku);

        return {
            image: imageElement ? imageElement.currentSrc || imageElement.src || CONFIG.fallbackImage : CONFIG.fallbackImage,
            name: titleElement ? sanitizeText(titleElement.textContent) : 'Product Added to Cart',
            sku: skuElement ? sanitizeText(skuElement.textContent) : '',
        };
    }

    function showBasicSuccessModal() {
        if (state.modalDismissed) return;

        const modal = document.querySelector(SELECTORS.modal);
        if (!modal) return;

        const modalContent = modal.querySelector(SELECTORS.modalContent);
        if (!modalContent) return;

        const productInfo = getLastAddedProductInfo();

        removeModalClose(modal);

        const addedQuantity = state.lastAddedQuantity || 1;
        const totalQuantity = state.currentCartTotal || addedQuantity;
        const headerText = getAddedItemsHeader(addedQuantity, totalQuantity);

        modalContent.innerHTML = `
            <div class="modal-header">
                <h1 class="modal-header-title">${headerText}</h1>
            </div>
            <div class="modal-body">
                <div class="previewCart">
                    <div class="productView">
                        <figure class="productView-image">
                            <div class="productView-img-container">
                                <img src="${escapeHtml(productInfo.image)}" alt="${escapeHtml(productInfo.name)}" title="${escapeHtml(productInfo.name)}">
                            </div>
                        </figure>
                        <div class="productView-details">
                            <h2 class="productView-title">${escapeHtml(productInfo.name)}</h2>
                            ${productInfo.sku ? `<div class="productView-brand">${escapeHtml(productInfo.sku)}</div>` : ''}
                        </div>
                    </div>
                    <div class="previewCartCheckout">
                        <p class="previewCartCheckout-status">
                            ✅ The product has been added to your cart.
                        </p>
                        <p class="previewCartCheckout-total">
                            ${renderCartTotalLine(totalQuantity)}
                        </p>
                        <a href="#" class="button button--primary js-plp-modal-continue">Continue Shopping</a>
                        <a href="/cart.php" class="button js-plp-modal-view-cart">View Cart</a>
                    </div>
                </div>
            </div>
        `;

        openModal(modal);
    }
    function showCartModalWithData(cartData) {
        if (state.modalDismissed) return;

        const modal = document.querySelector(SELECTORS.modal);
        if (!modal) return;

        const modalContent = modal.querySelector(SELECTORS.modalContent);
        if (!modalContent) return;

        const productInfo = getLastAddedProductInfo();

        const headerText = getAddedItemsHeader(state.lastAddedQuantity || cartData.quantity || 1, cartData.quantity);

        removeModalClose(modal);

        modalContent.innerHTML = `
            <div class="modal-header">
                <h1 class="modal-header-title">${headerText}</h1>
            </div>
            <div class="modal-body">
                <div class="previewCart">
                    <div class="productView">
                        <figure class="productView-image">
                            <div class="productView-img-container">
                                <img src="${escapeHtml(productInfo.image)}" alt="${escapeHtml(productInfo.name)}" title="${escapeHtml(productInfo.name)}">
                            </div>
                        </figure>
                        <div class="productView-details">
                            <h2 class="productView-title">${escapeHtml(productInfo.name)}</h2>
                            ${productInfo.sku ? `<div class="productView-brand">${escapeHtml(productInfo.sku)}</div>` : ''}
                        </div>
                    </div>
                    <div class="previewCartCheckout">
                        <a href="/checkout" class="button button--primary">Proceed to Checkout</a>
                        <div class="previewCartCheckout-subtotal">
                            Order subtotal
                            <strong class="previewCartCheckout-price">${escapeHtml(cartData.total)}</strong>
                        </div>
                        <p data-cart-quantity="${cartData.quantity}">
                            ${renderCartTotalLine(cartData.quantity)}
                        </p>
                        <a href="#" class="button button--primary js-plp-modal-continue">Continue Shopping</a>
                        <a href="/cart.php" class="button js-plp-modal-view-cart">View or edit your cart</a>
                    </div>
                </div>
            </div>
        `;

        openModal(modal);
    }

    function showAddToCartError() {
        if (state.modalDismissed) return;

        const modal = document.querySelector(SELECTORS.modal);
        if (!modal) return;

        const modalContent = modal.querySelector(SELECTORS.modalContent);
        if (!modalContent) return;

        removeModalClose(modal);

        modalContent.innerHTML = `
            <div class="modal-header">
                <h1 class="modal-header-title">Unable to add to cart</h1>
            </div>
            <div class="modal-body">
                <p>Something went wrong while adding this product to your cart. Please try again or continue to your cart page.</p>
                <div class="previewCartCheckout">
                    <a href="#" class="button button--primary js-plp-modal-continue">Try Again</a>
                    <a href="/cart.php" class="button js-plp-modal-view-cart">View Cart</a>
                </div>
            </div>
        `;

        openModal(modal);
    }

    function getAddedItemsHeader(addedQuantity, totalQuantity) {
        const added = Math.max(1, parseInt(addedQuantity, 10) || 1);
        const total = Math.max(0, parseInt(totalQuantity, 10) || 0);

        const addedLabel = added === 1 ? 'item' : 'items';
        const addedVerb = added === 1 ? 'was' : 'were';

        if (total > 0) {
            const totalLabel = total === 1 ? 'item' : 'items';
            const totalVerb = total === 1 ? 'was' : 'were';
            return `Ok, ${total} ${totalLabel} ${totalVerb} added to your cart. What's next?`;
        }

        return `Ok, ${added} ${addedLabel} ${addedVerb} added to your cart. What's next?`;
    }

    function renderCartTotalLine(totalQuantity) {
        const total = Math.max(0, parseInt(totalQuantity, 10) || 0);
        const label = total === 1 ? 'item' : 'items';
        return `Your cart contains ${total} ${label}`;
    }

    async function handleViewCartAction() {
        const expectedQuantity = state.currentCartTotal || state.baselineCartQuantity || 0;

        modalLoader.show();

        try {
            await state.pendingPricingUpdate;
        } catch (error) {
            console.warn('[simplePLPModal] Pending pricing update failed before view cart redirect', error);
        }

        if (!state.modalDismissed) {
            await redirectToCartAfterSync(expectedQuantity);
        }
    }

    function openModal(modal) {
        if (state.modalDismissed) return;

        ensureModalBackdrop();
        modal.style.setProperty('display', 'block', 'important');
        modal.style.setProperty('opacity', '1', 'important');
        modal.style.setProperty('visibility', 'visible', 'important');
        modal.style.setProperty('position', 'fixed', 'important');
        modal.style.setProperty('top', '50%', 'important');
        modal.style.setProperty('left', '50%', 'important');
        modal.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
        modal.style.setProperty('z-index', '1000', 'important');
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        removeModalClose(modal);
    }

    function ensureModalBackdrop() {
        let backdrop = document.querySelector('.modal-backdrop.simple-plp');
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.className = 'modal-backdrop simple-plp';
            backdrop.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,0.5);z-index:999;';
            document.body.appendChild(backdrop);
        } else {
            backdrop.removeEventListener('click', closeModal);
        }
        backdrop.style.display = 'block';
    }

    function closeModal() {
        const modal = document.querySelector(SELECTORS.modal);
        if (!modal) return;

        state.modalDismissed = true;

        modalLoader.ensureMinimumDisplay(false).catch(() => {});

        modal.style.setProperty('display', 'none', 'important');
        modal.style.setProperty('opacity', '0', 'important');
        modal.style.setProperty('visibility', 'hidden', 'important');
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');

        const backdrop = document.querySelector('.modal-backdrop.simple-plp');
        if (backdrop) {
            backdrop.style.display = 'none';
        }
    }

    function removeModalClose(modal) {
        if (!modal) return;
        const closeElements = modal.querySelectorAll(SELECTORS.modalClose);
        closeElements.forEach((element) => element.remove());
    }

    function initializeCartTotalTracking() {
        const selectors = [
            '.cart-quantity',
            '.cart-count',
            '[data-cart-quantity]',
            '.header-cart .count',
            '.cart-link .count',
            '.cart-icon .count',
            '.navUser-item--cart .count',
        ];

        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
                const parsed = parseInt(element.textContent.replace(/\D/g, ''), 10);
                if (!Number.isNaN(parsed) && parsed >= 0) {
                    window.currentCartTotal = parsed;
                    return parsed;
                }
            }
        }

        window.currentCartTotal = 0;
        return 0;
    }
    function getCartDataFromPage() {
        const quantitySelectors = [
            '.cart-quantity',
            '.cart-count',
            '[data-cart-quantity]',
            '.header-cart .count',
            '.cart-link .count',
            '.cart-icon .count',
            '.navUser-item--cart .count',
            '.cart-badge',
            '.cart-counter',
        ];

        let quantity = 0;
        for (const selector of quantitySelectors) {
            const element = document.querySelector(selector);
            if (element) {
                const parsed = parseInt(element.textContent.replace(/\D/g, ''), 10);
                if (!Number.isNaN(parsed)) {
                    quantity = parsed;
                    break;
                }
            }
        }

        const totalSelectors = [
            '.cart-total',
            '.cart-subtotal',
            '.header-cart .total',
            '.cart-link .total',
        ];

        let total = '$0.00';
        for (const selector of totalSelectors) {
            const element = document.querySelector(selector);
            if (element) {
                total = element.textContent.trim();
                break;
            }
        }

        return { quantity: Math.max(0, quantity), total: total || '$0.00', items: [] };
    }

    async function getCartDataFromAPI() {
        const timestamp = Date.now();
        const response = await fetch(`/api/storefront/cart?t=${timestamp}`, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
            },
        });

        if (!response.ok) {
            throw new Error(`Cart API responded with status ${response.status}`);
        }

        const data = await response.json();
        return normaliseCartData(data);
    }

    function normaliseCartData(cartData) {
        const descriptor = Array.isArray(cartData) ? cartData[0] : cartData;
        if (!descriptor) {
            return { quantity: 0, total: '$0.00', items: [] };
        }

        const lineItems = descriptor.lineItems || descriptor.line_items || {};
        const physicalItems = lineItems.physicalItems || lineItems.physical_items || [];
        const digitalItems = lineItems.digitalItems || lineItems.digital_items || [];
        const allItems = [...physicalItems, ...digitalItems];
        const quantity = allItems.reduce((sum, item) => sum + (parseInt(item.quantity, 10) || 0), 0);

        const amount = typeof descriptor.cartAmount === 'number'
            ? descriptor.cartAmount
            : typeof descriptor.cart_amount === 'number'
                ? descriptor.cart_amount
                : 0;

        const currencyCode = descriptor.currency && descriptor.currency.code;
        const total = formatCurrency(amount, currencyCode);

        return { quantity: Math.max(0, quantity), total, items: allItems };
    }

    function formatCurrency(amount, currencyCode) {
        if (!Number.isFinite(amount)) {
            return '$0.00';
        }

        const code = currencyCode || 'USD';
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: code,
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            }).format(amount);
        } catch (error) {
            const rounded = Math.round(amount * 100) / 100;
            return `${code} ${rounded.toFixed(2)}`;
        }
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function sanitizeText(text) {
        if (!text) return '';
        return text.replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    }

    window.closeTestModal = function closeTestModal() {
        closeModal();
    };

    window.simplePLPModal = {
        init,
        test: function test() {
            return {
                modalFound: document.getElementById('plpPreviewModal') !== null,
                buttonCount: document.querySelectorAll(SELECTORS.addToCartButton).length,
            };
        },
    };

    async function checkB2BAndUpdateCart(productId, quantity, button) {
        try {
            if (window.EpicorN8NPricing && typeof window.EpicorN8NPricing.isB2BCustomer === 'function') {
                const isB2B = window.EpicorN8NPricing.isB2BCustomer();
                if (isB2B) {
                    await delay(CONFIG.n8nWaitBeforeCart);
                    await updateCartViaN8NAfterAdd(productId, quantity, button);
                }
            }
        } catch (error) {
            console.warn('[simplePLPModal] B2B update failed', error);
        }
    }
    async function updateCartViaN8NAfterAdd(productId, quantity, button) {
        try {
            const card = button.closest(SELECTORS.card);
            const skuElement = card ? card.querySelector('[data-product-sku]') : null;
            let sku = skuElement ? sanitizeText(skuElement.textContent) : '';

            if (sku && /^SKU#/i.test(sku)) {
                sku = sku.replace(/^SKU#\s*/i, '').trim();
            }

            if (!sku && card) {
                const match = card.textContent.match(/SKU#\s*([A-Za-z0-9\-_.]+)/i);
                if (match && match[1]) {
                    sku = match[1];
                }
            }

            if (!sku) return;

            const cartId = await getCartId();
            if (!cartId) return;

            let epicorPrice = null;
            if (window.EpicorN8NPricing && typeof window.EpicorN8NPricing.getEpicorPriceForProduct === 'function') {
                epicorPrice = await window.EpicorN8NPricing.getEpicorPriceForProduct(productId, sku);
            }

            if (!epicorPrice) return;

            await updateCartPriceViaN8N(cartId, productId, sku, quantity, epicorPrice);
        } catch (error) {
            console.warn('[simplePLPModal] updateCartViaN8NAfterAdd error', error);
        }
    }

    async function updateCartPriceViaN8N(cartId, productId, sku, quantity, epicorPrice) {
        try {
            const cartItemDetails = await getCartItemDetails(cartId, productId, sku);
            if (!cartItemDetails) return false;

            const payload = {
                action: 'update_cart_prices',
                cart_id: cartId,
                cart_item: {
                    item_id: cartItemDetails.id,
                    product_id: productId,
                    variant_id: cartItemDetails.variantId || cartItemDetails.variant_id,
                    sku,
                    name: cartItemDetails.name,
                    quantity,
                    epicor_price: epicorPrice,
                },
                store_hash: '7eebdlwfu4',
                auth_token: 'pte9meprexvgw4td3ajlirxdsvk0e07',
            };

            const response = await fetch('https://cannon.n8n.asgard.dcw.dev/webhook/update-cart-price', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                return false;
            }

            let data;
            try {
                const text = await response.text();
                data = text.trim() ? JSON.parse(text) : { success: true };
            } catch (error) {
                data = { success: true };
            }

            if (data.success === false) {
                return false;
            }

            setTimeout(async () => {
                try {
                    const apiData = await getCartDataFromAPI();
                    if (apiData && apiData.quantity > 0) {
                        updateCartCounter(apiData.quantity);

                        const modal = document.querySelector(SELECTORS.modal);
                        if (modal && modal.style.display !== 'none') {
                            const summary = modal.querySelector('[data-cart-quantity]');
                            if (summary) {
                                const finalQuantity = Math.max(apiData.quantity, state.currentCartTotal || 0);
                                summary.setAttribute('data-cart-quantity', finalQuantity);
                                summary.textContent = `Your cart contains ${finalQuantity} ${finalQuantity === 1 ? 'item' : 'items'}`;
                            }
                        }
                    }
                } catch (error) {
                    console.warn('[simplePLPModal] Unable to refresh cart after N8N update', error);
                }
            }, 500);

            hideAdditionalLoaders();
            return true;
        } catch (error) {
            hideAdditionalLoaders();
            return false;
        }
    }

    function hideAdditionalLoaders() {
        try {
            document.querySelectorAll('.modal .loadingOverlay').forEach((overlay) => {
                if (overlay.getAttribute('data-loader-source') !== 'simple-plp') {
                    overlay.style.display = 'none';
                }
            });

            if (window.$ && window.$.fn && window.$.fn.reveal) {
                window.$('.modal .loadingOverlay').hide();
            }

            const event = new CustomEvent('stopLoader');
            document.dispatchEvent(event);
        } catch (error) {
            console.warn('[simplePLPModal] hideAdditionalLoaders error', error);
        }
    }

    async function getCartId() {
        try {
            const response = await fetch('/api/storefront/cart', {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                return data[0].id;
            }
            if (data && data.id) {
                return data.id;
            }
        } catch (error) {
            console.warn('[simplePLPModal] getCartId error', error);
        }
        return null;
    }

    async function getCartItemDetails(cartId, productId, sku) {
        try {
            const response = await fetch(`/api/storefront/checkouts/${cartId}`, {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) return null;

            const checkoutData = await response.json();
            const physicalItems = extractPhysicalItems(checkoutData);
            if (!physicalItems) return null;

            return findMatchingLineItem(physicalItems, productId, sku) || getCartItemDetailsFallback(productId, sku);
        } catch (error) {
            return getCartItemDetailsFallback(productId, sku);
        }
    }

    async function getCartItemDetailsFallback(productId, sku) {
        try {
            const response = await fetch('/api/storefront/cart', {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!response.ok) return null;

            const cartData = await response.json();
            const physicalItems = extractPhysicalItems(cartData);
            if (!physicalItems) return null;

            return findMatchingLineItem(physicalItems, productId, sku);
        } catch (error) {
            return null;
        }
    }
    function extractPhysicalItems(data) {
        if (!data) return null;

        const descriptor = Array.isArray(data) ? data[0] : data;
        if (!descriptor) return null;

        if (descriptor.cart && descriptor.cart.line_items && descriptor.cart.line_items.physical_items) {
            return descriptor.cart.line_items.physical_items;
        }
        if (descriptor.cart && descriptor.cart.lineItems && descriptor.cart.lineItems.physicalItems) {
            return descriptor.cart.lineItems.physicalItems;
        }
        if (descriptor.line_items && descriptor.line_items.physical_items) {
            return descriptor.line_items.physical_items;
        }
        if (descriptor.lineItems && descriptor.lineItems.physicalItems) {
            return descriptor.lineItems.physicalItems;
        }
        if (descriptor.physicalItems) {
            return descriptor.physicalItems;
        }
        return null;
    }

    function findMatchingLineItem(items, productId, sku) {
        if (!Array.isArray(items)) return null;

        let latestItem = null;
        let latestTimestamp = 0;

        items.forEach((item) => {
            const itemProductId = item.productId || item.product_id;
            const itemSku = item.sku || '';

            const cleanSku = sku.replace(/^SKU#\s*/i, '');
            const skuMatch = itemSku === sku || itemSku === cleanSku || itemSku === `SKU# ${cleanSku}`;

            if (itemProductId == productId && skuMatch) {
                const created = item.createdTime || item.created_time || item.updatedTime || item.updated_time;
                const timestamp = created ? new Date(created).getTime() : Date.now();
                if (timestamp > latestTimestamp) {
                    latestItem = item;
                    latestTimestamp = timestamp;
                }
            }
        });

        return latestItem;
    }
})();
