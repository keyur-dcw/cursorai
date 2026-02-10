import 'foundation-sites/js/foundation/foundation';
import 'foundation-sites/js/foundation/foundation.dropdown';
import utils from '@bigcommerce/stencil-utils';

export const CartPreviewEvents = {
    close: 'closed.fndtn.dropdown',
    open: 'opened.fndtn.dropdown',
};

const PREVIEW_CACHE_TTL_MS = 10000;
const LOADER_DELAY_MS = 180;
const REQUEST_TIMEOUT_MS = 8000;

export default function (secureBaseUrl, cartId) {
    const loadingClass = 'is-loading';
    const $cart = $('[data-cart-preview]');
    const $cartDropdown = $('#cart-preview-dropdown');
    const $cartLoading = $('<div class="loadingOverlay"></div>');
    const $body = $('body');

    let inFlightRequest = null;
    let previewCache = {
        html: '',
        timestamp: 0,
        quantity: 0,
    };

    if (window.ApplePaySession) {
        $cartDropdown.addClass('apple-pay-supported');
    }

    const getRenderedQuantity = () => {
        const raw = $('.cart-quantity').first().text();
        const parsed = Number(raw);
        return Number.isNaN(parsed) ? 0 : parsed;
    };

    const resetPreviewCache = () => {
        previewCache = {
            html: '',
            timestamp: 0,
            quantity: getRenderedQuantity(),
        };
    };

    const isPreviewCacheFresh = () => {
        const hasFreshHtml = previewCache.html && (Date.now() - previewCache.timestamp) < PREVIEW_CACHE_TTL_MS;
        if (!hasFreshHtml) {
            return false;
        }

        return previewCache.quantity === getRenderedQuantity();
    };

    const renderCartPreview = html => {
        $cartDropdown
            .removeClass(loadingClass)
            .html(html);
        $cartLoading.hide();
    };

    const savePreviewCache = html => {
        previewCache = {
            html,
            timestamp: Date.now(),
            quantity: getRenderedQuantity(),
        };
    };

    const requestCartPreview = ({ showLoader = true, forceRefresh = false } = {}) => {
        if (!forceRefresh && isPreviewCacheFresh()) {
            renderCartPreview(previewCache.html);
            return Promise.resolve(previewCache.html);
        }

        if (inFlightRequest) {
            return inFlightRequest;
        }

        let requestDone = false;
        let loaderTimerId = null;
        let timeoutId = null;

        if (showLoader) {
            loaderTimerId = window.setTimeout(() => {
                if (requestDone) {
                    return;
                }

                $cartDropdown
                    .addClass(loadingClass)
                    .empty()
                    .append($cartLoading);
                $cartLoading.show();
            }, LOADER_DELAY_MS);
        }

        inFlightRequest = new Promise((resolve, reject) => {
            timeoutId = window.setTimeout(() => {
                if (requestDone) {
                    return;
                }

                requestDone = true;
                reject(new Error('Cart preview request timed out'));
            }, REQUEST_TIMEOUT_MS);

            utils.api.cart.getContent({ template: 'common/cart-preview' }, (err, response) => {
                if (requestDone) {
                    return;
                }

                requestDone = true;

                if (err) {
                    reject(err);
                    return;
                }

                resolve(response);
            });
        })
            .then(response => {
                savePreviewCache(response);
                renderCartPreview(response);
                return response;
            })
            .catch(error => {
                if (previewCache.html) {
                    renderCartPreview(previewCache.html);
                    return previewCache.html;
                }

                $cartDropdown.removeClass(loadingClass);
                $cartLoading.hide();
                throw error;
            })
            .finally(() => {
                if (loaderTimerId) {
                    window.clearTimeout(loaderTimerId);
                }

                if (timeoutId) {
                    window.clearTimeout(timeoutId);
                }

                inFlightRequest = null;
            });

        return inFlightRequest;
    };

    const openCartPreview = () => {
        if (isPreviewCacheFresh()) {
            renderCartPreview(previewCache.html);

            // Refresh silently in the background to keep cache warm.
            requestCartPreview({ showLoader: false, forceRefresh: true }).catch(() => {});
            return;
        }

        requestCartPreview({ showLoader: true, forceRefresh: true }).catch(() => {});
    };

    const prefetchCartPreview = () => {
        if (isPreviewCacheFresh() || inFlightRequest) {
            return;
        }

        requestCartPreview({ showLoader: false, forceRefresh: true }).catch(() => {});
    };

    $body.on('cart-quantity-update', (event, quantity) => {
        const normalizedQuantity = Number(quantity) || 0;
        const previousLabel = $cart.attr('aria-label') || '';

        if (/\d+/.test(previousLabel)) {
            $cart.attr('aria-label', previousLabel.replace(/\d+/, normalizedQuantity));
        } else {
            $cart.attr('aria-label', `Cart with ${normalizedQuantity} items`);
        }

        if (!normalizedQuantity) {
            $cart.addClass('navUser-item--cart__hidden-s');
        } else {
            $cart.removeClass('navUser-item--cart__hidden-s');
        }

        $('.cart-quantity')
            .text(normalizedQuantity)
            .toggleClass('countPill--positive', normalizedQuantity > 0);

        if (utils.tools.storage.localStorageAvailable()) {
            localStorage.setItem('cart-quantity', normalizedQuantity);
        }

        if (previewCache.quantity !== normalizedQuantity) {
            resetPreviewCache();
            previewCache.quantity = normalizedQuantity;
        }
    });

    $cart.on('mouseenter focusin', prefetchCartPreview);

    $cart.on('click', event => {
        // Redirect to full cart page for mobile browsers.
        if (/Mobi/i.test(navigator.userAgent)) {
            return event.stopPropagation();
        }

        event.preventDefault();
        openCartPreview();
    });

    let quantity = 0;

    if (cartId) {
        if (utils.tools.storage.localStorageAvailable()) {
            const storedQuantity = localStorage.getItem('cart-quantity');
            if (storedQuantity !== null) {
                quantity = Number(storedQuantity) || 0;
                $body.trigger('cart-quantity-update', quantity);
            }
        }

        const cartQtyPromise = new Promise((resolve, reject) => {
            utils.api.cart.getCartQuantity({ baseUrl: secureBaseUrl, cartId }, (err, qty) => {
                if (err) {
                    if (err === 'Not Found') {
                        resolve(0);
                    } else {
                        reject(err);
                    }
                    return;
                }

                resolve(qty);
            });
        });

        cartQtyPromise
            .then(qty => {
                quantity = Number(qty) || 0;
                $body.trigger('cart-quantity-update', quantity);
            })
            .catch(() => {
                // Keep previous quantity if API fails.
            });
    } else {
        $body.trigger('cart-quantity-update', quantity);
    }
}
