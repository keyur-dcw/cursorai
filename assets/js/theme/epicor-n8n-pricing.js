/**
 * Epicor N8N Pricing Integration - Main Script
 * Handles B2B customer detection, Epicor pricing, and UI updates
 */

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        N8N_WEBHOOK_URL: 'https://cannon.n8n.asgard.dcw.dev/webhook/epicor-pricing',
        N8N_CART_WEBHOOK_URL: 'https://cannon.n8n.asgard.dcw.dev/webhook/update-cart-price',
        B2B_AUTH_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdG9yZV9oYXNoIjoiN2VlYmRsd2Z1NCIsImRiIjoiZGVmYXVsdCIsImVtYWlsIjoia2V5dXJAZG90Y29td2VhdmVycy5jb20iLCJuYW1lIjoiVjNBcGlUb2tlbiIsImV2ZW50X2NoYW5uZWwiOiJhcHAiLCJ0b2tlbl92ZXJzaW9uIjoidjMifQ.CNaHMWbRsf49Zk4XNDNaEwTQF-gdSVaOmIGb3wR-BkQ',
        B2B_CUSTOMER_API: 'https://api-b2b.bigcommerce.com/api/v3/io/users/customer/',
        B2B_COMPANY_API: 'https://api-b2b.bigcommerce.com/api/v3/io/companies/',
        BIGCOMMERCE_STORE_HASH: '7eebdlwfu4',
        BIGCOMMERCE_AUTH_TOKEN: 'pte9meprexvgw4td3ajlirxdsvk0e07',
        CACHE_TIMEOUT: 5 * 60 * 1000,
        BATCH_SIZE: 3,
        VIEW_EDIT_CART_MAX_WAIT: 20000,
        VIEW_EDIT_CART_MIN_SPIN: 10000,
        VIEW_EDIT_CART_POST_COMPLETION_DELAY: 2000,
        VIEW_EDIT_CART_LOADER_FALLBACK: 15000,
        N8N_STATUS_CHECK_INTERVAL: 100
    };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    ensureN8NProcessingStatus();

    function ensureN8NProcessingStatus() {
        if (!window.N8NProcessingStatus) {
            window.N8NProcessingStatus = {
                inProgress: false,
                completed: false,
                completionTime: null,
                awaitingCartNavigation: false,
                cartUpdateComplete: false,
                cartUpdateStartTime: null,
            };
        }
    }

    const hasNativeIsArray = typeof Array !== 'undefined' && typeof Array['isArray'] === 'function';
    const isArray = (value) => hasNativeIsArray ? Array['isArray'](value) : Object.prototype.toString.call(value) === '[object Array]';

    function markN8NProcessingStart() {
        ensureN8NProcessingStatus();
        window.N8NProcessingStatus.inProgress = true;
        window.N8NProcessingStatus.completed = false;
        window.N8NProcessingStatus.completionTime = null;
        window.N8NProcessingStatus.awaitingCartNavigation = false;
        window.N8NProcessingStatus.cartUpdateComplete = false;
        window.N8NProcessingStatus.cartUpdateStartTime = null;
    }

    function markN8NProcessingComplete() {
        ensureN8NProcessingStatus();
        window.N8NProcessingStatus.inProgress = false;
        window.N8NProcessingStatus.completed = true;
        window.N8NProcessingStatus.completionTime = new Date();
        window.N8NProcessingStatus.awaitingCartNavigation = false;
    }

    function markCartUpdateStart() {
        ensureN8NProcessingStatus();
        window.N8NProcessingStatus.cartUpdateStartTime = new Date();
        window.N8NProcessingStatus.cartUpdateComplete = false;
    }

    function markCartUpdateComplete() {
        ensureN8NProcessingStatus();
        window.N8NProcessingStatus.cartUpdateComplete = true;
        window.N8NProcessingStatus.cartUpdateStartTime = null;
    }

    class EpicorN8NPricing {
        constructor() {
            this.n8nWebhookUrl = CONFIG.N8N_WEBHOOK_URL;
            this.n8nCartWebhookUrl = CONFIG.N8N_CART_WEBHOOK_URL;
            this.cache = new Map();
            this.cacheTimeout = CONFIG.CACHE_TIMEOUT;
            this.isProcessing = false;
            this.b2bData = null;
            this.isCartPricingComplete = false;
            this.loaderFallbackTimeout = null;
        }

        // Initialize pricing for all products
        init() {

            if (!this.isB2BCustomer()) {
                // Show loading then original prices for non-B2B customers (similar to B2B logic)
                setTimeout(() => {
                    this.showLoadingThenOriginalPricesForNonB2B();
                }, 100);
                return;
            }

            // Check if this is a cart page
            if (this.isCartPage()) {
                this.initCartPricing();
                return;
            }

            const productElements = this.getProductElements();

            if (productElements.length === 0) {
                return;
            }

            this.processProducts(productElements);

            // Set up mutation observer for dynamically loaded content
            this.setupMutationObserver();

            // Set up periodic check for unprocessed products
            this.setupPeriodicCheck();

            // Set up event listeners for slider initialization
            this.setupSliderEventListeners();
        }

        // Initialize after B2B data is loaded
        initAfterB2BData() {

            // Check if this is a cart page first
            if (this.isCartPage()) {
                this.processCartWithEpicorPricing();
                return;
            }

            // First, reset processed status for products that shouldn't show prices
            this.resetProcessedStatusForHiddenProducts();

            const productElements = this.getProductElements();

            if (productElements.length === 0) {
                return;
            }

            this.processProducts(productElements);

            // Also process related products specifically
            this.processRelatedProducts();
        }

        // Check if current customer is B2B
        isB2BCustomer() {
            if (window.b2bCustomerData && window.b2bCustomerData.customer_id) {
                return true;
            }

            if (this.isCompanyCustomer()) {
                return true;
            }

            if (window.isB2BCustomer === true) {
                return true;
            }

            return false;
        }

        // Check if customer is a company customer
        isCompanyCustomer() {
            try {
                if (window.customer && window.customer.company_id) {
                    return true;
                }

                if (window.customer && window.customer.custom_fields) {
                    const customFields = window.customer.custom_fields;
                    if (customFields.custId || customFields.custGroupCode || customFields.companyName) {
                        return true;
                    }
                }

                return false;
            } catch (error) {
                return false;
            }
        }

        // Get customer data
        async getCustomerData() {
            if (window.b2bCustomerData) {
                this.b2bData = window.b2bCustomerData;
                return window.b2bCustomerData;
            }

            try {
                const customerData = this.getCustomerDataFromContext();

                if (customerData) {
                    window.b2bCustomerData = customerData;
                    this.b2bData = customerData;
                    return customerData;
                }

                const b2bData = await this.getB2BCustomerData();
                if (b2bData) {
                    window.b2bCustomerData = b2bData;
                    this.b2bData = b2bData;
                    return b2bData;
                }

                return null;

            } catch (error) {
                return null;
            }
        }

        // Get customer data from context
        getCustomerDataFromContext() {
            try {
                if (window.customer && window.customer.id) {
                    const customer = window.customer;
                    const customFields = customer.custom_fields || {};

                    if (customFields.custId || customFields.custGroupCode) {
                        return {
                            customer_id: customFields.custId || customer.id.toString(),
                            customer_group_code: customFields.custGroupCode || '',
                            ship_to_num: customFields.shipToNum || ''
                        };
                    }
                }

                return null;
            } catch (error) {
                return null;
            }
        }

        // Get B2B customer data from API
        async getB2BCustomerData() {
            try {
                if (!window.customer || !window.customer.id) {
                    return null;
                }

                const response = await fetch(CONFIG.B2B_CUSTOMER_API + window.customer.id, {
                    headers: {
                        'authToken': CONFIG.B2B_AUTH_TOKEN
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const customerData = this.extractCustomerData(data);
                    return customerData;
                } else {
                    return null;
                }
            } catch (error) {
                return null;
            }
        }

        // Extract customer data from API response
        extractCustomerData(apiResponse) {
            try {
                if (apiResponse.data && apiResponse.data.length > 0) {
                    const company = apiResponse.data[0];
                    const extraFields = company.extraFields || {};

                    return {
                        customer_id: extraFields.CustID || company.id,
                        customer_group_code: extraFields.EpicorGroupCode || '',
                        ship_to_num: extraFields.ShipToNum || ''
                    };
                }
                return null;
            } catch (error) {
                return null;
            }
        }

        // Get all product elements on any page
        getProductElements() {
            const selectors = [
                '.card[data-product-sku]',
                '.listItem[data-product-sku]',
                '.productView[data-product-sku]',
                '.product-item[data-product-sku]',
                '.wishlist-item[data-product-sku]',
                '.compare-item[data-product-sku]',
                '.productView-price[data-product-id]',
                '[data-product-sku]',
                'article[data-entity-id]',
                '.card[data-entity-id]',
                '.listItem[data-entity-id]',
                '.product[data-entity-id]',
                '[data-entity-id]',
                '.heroCarousel .card',
                '.featured-products .card',
                '.product-slider .card',
                '.slick-slide .card',
                '.productCarousel-slide .card',
                '.productCarousel-slide article',
                '.carousel .card',
                '.slider .card',
                '.productGrid .card',
                '.productGrid .product',
                '.productGrid article',
                '.productGrid .listItem',
                '.productGrid .product-item',
                '.related-products-wrapper .card',
                '.related-products-wrapper article',
                '.related-products .card',
                '.related-products article'
            ];

            const elements = [];
            selectors.forEach(selector => {
                const found = document.querySelectorAll(selector);
                found.forEach(el => {
                    const productId = el.getAttribute('data-entity-id') ||
                        el.getAttribute('data-product-id') ||
                        el.getAttribute('data-product-sku') ||
                        el.getAttribute('data-test')?.replace('card-', '');

                    if (productId && !elements.find(existing => {
                        const existingId = existing.getAttribute('data-entity-id') ||
                            existing.getAttribute('data-product-id') ||
                            existing.getAttribute('data-product-sku') ||
                            existing.getAttribute('data-test')?.replace('card-', '');
                        return existingId === productId;
                    })) {
                        elements.push(el);
                    }
                });
            });

            return elements;
        }

        isQuickViewElement(element) {
            if (!element || typeof element.closest !== 'function') {
                return false;
            }
            return Boolean(element.closest('#modal, .modal'));
        }

        // Process all products
        async processProducts(elements) {
            const elementsToProcess = elements.filter(element =>
                this.shouldShowPrice(element) &&
                !element.hasAttribute('data-epicor-processed') &&
                !this.isQuickViewElement(element)
            );

            if (elementsToProcess.length === 0) {
                return;
            }

            elementsToProcess.forEach(element => {
                this.showLoadingState(element);
            });

            const batches = [];
            for (let i = 0; i < elementsToProcess.length; i += CONFIG.BATCH_SIZE) {
                batches.push(elementsToProcess.slice(i, i + CONFIG.BATCH_SIZE));
            }

            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];

                const promises = batch.map(element => this.processProduct(element));
                await Promise.all(promises);

                if (i < batches.length - 1) {
                    await this.delay(500);
                }
            }

        }

        // Process a single product
        async processProduct(element) {
            try {
                if (element.hasAttribute('data-epicor-processed') || element.hasAttribute('data-epicor-processing')) {
                    return;
                }

                element.setAttribute('data-epicor-processing', 'true');

                const productData = await this.getProductData(element);
                if (!productData || !productData.product_id) {
                    element.removeAttribute('data-epicor-processing');
                    return;
                }

                const customerData = await this.getCustomerData();
                if (!customerData) {
                    element.removeAttribute('data-epicor-processing');
                    return;
                }

                const cacheKey = this.getCacheKey(customerData, productData);
                const cached = this.cache.get(cacheKey);

                if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
                    this.updateProductPrice(element, cached.pricing);
                    element.setAttribute('data-epicor-processed', 'true');
                    element.removeAttribute('data-epicor-processing');
                    return;
                }

                const pricing = await this.getPriceFromN8N(customerData, productData);

                this.cache.set(cacheKey, {
                    pricing: pricing,
                    timestamp: Date.now()
                });

                this.updateProductPrice(element, pricing);
                element.setAttribute('data-epicor-processed', 'true');
                element.removeAttribute('data-epicor-processing');

            } catch (error) {
                element.setAttribute('data-epicor-processed', 'true');
                element.removeAttribute('data-epicor-processing');
            }
        }

        // Get product data
        async getProductData(element) {
            const productId = this.getNumericProductId(element);
            if (!productId) {
                return null;
            }

            const sku = this.getSkuFromElement(element);

            return {
                product_id: productId,
                sku: sku,
                quantity: parseInt(element.getAttribute('data-quantity')) || 1
            };
        }

        getNumericProductId(element) {
            if (!element) {
                return null;
            }

            const candidates = [];

            const addCandidate = (value) => {
                if (value === undefined || value === null) {
                    return;
                }
                const trimmed = String(value).trim();
                if (trimmed) {
                    candidates.push(trimmed);
                }
            };

            const collectFromElement = (el) => {
                if (!el) {
                    return;
                }
                addCandidate(el.getAttribute?.('data-product-id'));
                addCandidate(el.getAttribute?.('data-entity-id'));

                const dataTest = el.getAttribute?.('data-test');
                if (dataTest && dataTest.includes('card-')) {
                    addCandidate(dataTest.replace('card-', ''));
                }

                const dataSku = el.getAttribute?.('data-product-sku');
                if (dataSku && /^\d+$/.test(dataSku.trim())) {
                    addCandidate(dataSku);
                }

                if (typeof el.querySelector === 'function') {
                    const hiddenInput = el.querySelector('input[name="product_id"]');
                    if (hiddenInput && hiddenInput.value) {
                        addCandidate(hiddenInput.value);
                    }
                }
            };

            collectFromElement(element);

            let current = element.parentElement;
            let depth = 0;
            while (current && depth < 5) {
                collectFromElement(current);
                current = current.parentElement;
                depth += 1;
            }

            if (this.isQuickViewElement(element)) {
                const quickviewRoot = element.closest('#modal, .modal');
                if (quickviewRoot) {
                    collectFromElement(quickviewRoot);
                    const quickviewInput = quickviewRoot.querySelector('input[name="product_id"]');
                    if (quickviewInput && quickviewInput.value) {
                        addCandidate(quickviewInput.value);
                    }
                }
            }

            for (const candidate of candidates) {
                if (/^\d+$/.test(candidate)) {
                    return candidate;
                }
            }

            return null;
        }

        getSkuFromElement(element) {
            if (!element) {
                return '';
            }

            const readSkuValue = (el) => {
                if (!el) {
                    return '';
                }

                const attrSku = typeof el.getAttribute === 'function' ? el.getAttribute('data-product-sku') : null;
                if (attrSku) {
                    return attrSku.trim();
                }

                const text = el.textContent || el.innerText || '';
                if (text) {
                    const match = text.match(/SKU#?\s*([A-Za-z0-9.\-_]+)/i);
                    if (match && match[1]) {
                        return match[1].trim();
                    }
                    return text.trim();
                }

                return '';
            };

            const directValue = readSkuValue(element);
            if (directValue) {
                return directValue;
            }

            const internalNode = element.querySelector?.('[data-product-sku], .card-sku, .product-sku, .productView-sku, .productView-info .sku, [data-test-info-type="sku"]');
            if (internalNode) {
                const internalValue = readSkuValue(internalNode);
                if (internalValue) {
                    return internalValue;
                }
            }

            const ancestor = element.closest?.('[data-product-sku]');
            if (ancestor) {
                const ancestorValue = readSkuValue(ancestor);
                if (ancestorValue) {
                    return ancestorValue;
                }
            }

            return '';
        }

        // Get cache key
        getCacheKey(customerData, productData) {
            const skuPart = productData.sku ? productData.sku : 'nosku';
            return `${customerData.customer_id}-${customerData.customer_group_code}-${productData.product_id}-${skuPart}-${productData.quantity}`;
        }

        // Fetch price from N8N
        async getPriceFromN8N(customerData, productData) {
            try {
                const requestData = {
                    customer_id: customerData.customer_id,
                    customer_group_code: customerData.customer_group_code,
                    ship_to_num: customerData.ship_to_num || '',
                    product_id: productData.product_id,
                    sku: productData.sku || '',
                    quantity: productData.quantity
                };

                const response = await fetch(this.n8nWebhookUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestData)
                });

                if (!response.ok) {
                    throw new Error(`N8N webhook error: ${response.status}`);
                }

                let data;
                try {
                    data = await response.json();
                } catch (jsonError) {
                    return null;
                }

                if (data.success && data.pricing && data.pricing.valid) {
                    return {
                        success: true,
                        netPrice: data.pricing.netPrice || 0,
                        basePrice: data.pricing.basePrice || 0,
                        currency: data.pricing.currency || 'USD',
                        discount: data.pricing.discount || 0,
                        valid: true
                    };
                } else {
                    return {
                        success: false,
                        error: data.pricing?.error || 'No pricing data',
                        valid: false
                    };
                }

            } catch (error) {
                return {
                    success: false,
                    error: error.message,
                    valid: false
                };
            }
        }

        // Update product price display
        updateProductPrice(element, pricing) {
            const shouldShowPrice = this.shouldShowPrice(element);

            if (!shouldShowPrice) {
                const priceSelectors = [
                    '[data-product-price-with-tax]',
                    '[data-product-price-without-tax]',
                    '.price',
                    '.productPrice',
                    '.card-price',
                    '.listItem-price',
                    '.productView-price .price',
                    '.productView-price span[class*="price"]',
                    '.productView-price',
                    '.wishlist-item-price',
                    '.compare-item-price',
                    '.card-text[data-test-info-type="price"]',
                    '.price-loading',
                    '.price-content'
                ];

                priceSelectors.forEach(selector => {
                    const priceEl = element.querySelector(selector);
                    if (priceEl) {
                        priceEl.style.display = 'none';
                    }
                });
                return;
            }

            if (!pricing || !pricing.valid) {
                return;
            }

            element.removeAttribute('data-epicor-loading');

            const priceSelectors = [
                '[data-product-price-with-tax]',
                '[data-product-price-without-tax]',
                '.price',
                '.productPrice',
                '.card-price',
                '.listItem-price',
                '.productView-price .price',
                '.productView-price span[class*="price"]',
                '.productView-price',
                '.wishlist-item-price',
                '.compare-item-price'
            ];

            priceSelectors.forEach(selector => {
                const priceEl = element.querySelector(selector);
                if (priceEl) {
                    const originalPrice = priceEl.textContent;
                    priceEl.textContent = this.formatPrice(pricing.netPrice, pricing.currency);

                    priceEl.setAttribute('data-original-price', originalPrice);
                    priceEl.setAttribute('data-epicor-price', this.formatPrice(pricing.netPrice, pricing.currency));
                }
            });
        }

        // Check if product should show price
        shouldShowPrice(element) {
            const priceShow = element.getAttribute('data-price-show');

            if (priceShow && priceShow.toLowerCase() === 'no') {
                return false;
            }

            if (priceShow && priceShow.toLowerCase() === 'yes') {
                return true;
            }

            const elementShowPrice = element.getAttribute('data-show-price');
            if (elementShowPrice && elementShowPrice.toLowerCase() === 'yes') {
                return true;
            }

            const productShowPrice = this.getProductCustomFieldValue(element, 'show_price');
            if (productShowPrice && productShowPrice.toLowerCase() === 'yes') {
                return true;
            }

            const isRelatedProduct = element.closest('.related-products-wrapper, .productCarousel, .slick-slide');
            if (!isRelatedProduct) {
                try {
                    const dataEl = document.getElementById('productCustomFields');
                    if (dataEl) {
                        const fields = JSON.parse(dataEl.textContent || '[]');
                        if (isArray(fields)) {
                            for (let i = 0; i < fields.length; i++) {
                                const f = fields[i];
                                if (f && f.name && f.value &&
                                    String(f.name).toLowerCase() === 'show_price' &&
                                    String(f.value).toLowerCase() === 'yes') {
                                    return true;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Error checking show_price custom field:', e);
                }
            }

            return false;
        }

        // Get custom field value from product element
        getProductCustomFieldValue(element, fieldName) {
            try {
                const dataValue = element.getAttribute(`data-${fieldName}`);
                if (dataValue) {
                    return dataValue;
                }

                const scriptTags = element.querySelectorAll('script[type="application/json"]');
                for (let i = 0; i < scriptTags.length; i++) {
                    try {
                        const data = JSON.parse(scriptTags[i].textContent || '{}');
                        if (data[fieldName]) {
                            return data[fieldName];
                        }
                    } catch (e) {
                    }
                }

                const hiddenInput = element.querySelector(`input[name="${fieldName}"], input[data-field="${fieldName}"]`);
                if (hiddenInput && hiddenInput.value) {
                    return hiddenInput.value;
                }

                return null;
            } catch (e) {
                console.warn(`Error getting custom field ${fieldName}:`, e);
                return null;
            }
        }

        // Show loading state
        showLoadingState(element) {
            const shouldShowPrice = this.shouldShowPrice(element);

            if (!shouldShowPrice) {
                return;
            }

            if (element.hasAttribute('data-epicor-processed') || element.hasAttribute('data-epicor-loading')) {
                return;
            }

            element.setAttribute('data-epicor-loading', 'true');

            const priceElements = element.querySelectorAll('.price, .productPrice, [data-product-price-with-tax], [data-product-price-without-tax]');
            priceElements.forEach(el => {
                if (!el.textContent.includes('Loading')) {
                    el.textContent = 'Loading...';
                }
            });
        }

        // Hide product price completely
        hideProductPrice(element) {
            const priceSelectors = [
                '[data-product-price-with-tax]',
                '[data-product-price-without-tax]',
                '.price',
                '.productPrice',
                '.card-price',
                '.listItem-price',
                '.productView-price .price',
                '.productView-price span[class*="price"]',
                '.productView-price',
                '.wishlist-item-price',
                '.compare-item-price',
                '.card-text[data-test-info-type="price"]',
                '.price-loading',
                '.price-content'
            ];

            priceSelectors.forEach(selector => {
                const priceEl = element.querySelector(selector);
                if (priceEl) {
                    priceEl.style.display = 'none';
                }
            });
        }

        // Reset processed status for products that shouldn't show prices
        resetProcessedStatusForHiddenProducts() {
            const allProductElements = this.getProductElements();

            allProductElements.forEach(element => {
                if (element.hasAttribute('data-epicor-processed') && !this.shouldShowPrice(element)) {
                    element.removeAttribute('data-epicor-processed');
                    this.hideProductPrice(element);
                }
            });
        }

        // Format price
        formatPrice(price, currency = 'USD') {
            return new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: currency
            }).format(price);
        }

        // Update all page prices
        async updateAllPagePrices() {

            const productElements = this.getProductElements();
            if (productElements.length === 0) {
                return;
            }

            await this.processProducts(productElements);
        }

        // Check for new products and update pricing
        checkForNewProducts() {
            const productElements = this.getProductElements();
            const processedElements = document.querySelectorAll('[data-epicor-processed="true"]');

            if (productElements.length > processedElements.length) {
                this.updateAllPagePrices();
            }
        }

        // Delay function
        delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // Refresh all products
        refreshAll() {
            this.cache.clear();
            this.cleanup();
            this.init();
        }

        // Cleanup intervals and observers
        cleanup() {
            if (this.mutationObserver) {
                this.mutationObserver.disconnect();
                this.mutationObserver = null;
            }

            if (this.periodicCheckInterval) {
                clearInterval(this.periodicCheckInterval);
                this.periodicCheckInterval = null;
            }

            if (this.mutationTimeout) {
                clearTimeout(this.mutationTimeout);
                this.mutationTimeout = null;
            }
        }

        // Set up mutation observer for dynamically loaded content
        setupMutationObserver() {
            if (this.mutationObserver) {
                this.mutationObserver.disconnect();
            }

            this.mutationObserver = new MutationObserver((mutations) => {
                let shouldProcess = false;

                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                if (this.isProductElement(node) || node.querySelector && node.querySelector('[data-entity-id], [data-product-sku], .card[data-test]')) {
                                    shouldProcess = true;
                                }
                            }
                        });
                    }
                });

                if (shouldProcess) {
                    clearTimeout(this.mutationTimeout);
                    this.mutationTimeout = setTimeout(() => {
                        this.processNewProducts();
                    }, 500);
                }
            });

            this.mutationObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        // Check if an element is a product element
        isProductElement(element) {
            return element.matches && (
                element.matches('[data-entity-id]') ||
                element.matches('[data-product-sku]') ||
                element.matches('.card[data-test]') ||
                element.matches('.slick-slide .card') ||
                element.matches('.productCarousel-slide .card')
            );
        }

        // Process new products that were dynamically added
        async processNewProducts() {
            const allProductElements = this.getProductElements();

            const unprocessedElements = Array.from(allProductElements).filter(element =>
                !element.hasAttribute('data-epicor-processed') &&
                this.shouldShowPrice(element) &&
                !this.isQuickViewElement(element)
            );

            if (unprocessedElements.length > 0) {
                await this.processProducts(unprocessedElements);
            }
        }

        // Process related products specifically
        async processRelatedProducts() {
            const relatedProductSelectors = [
                '.related-products-wrapper .card',
                '.related-products-wrapper article',
                '.related-products .card',
                '.related-products article',
                '.productCarousel-slide .card',
                '.productCarousel-slide article',
                '.slick-slide .card',
                '.slick-slide article'
            ];

            const relatedElements = [];
            relatedProductSelectors.forEach(selector => {
                const found = document.querySelectorAll(selector);
                found.forEach(el => {
                    if (this.isQuickViewElement(el)) {
                        return;
                    }

                    const productId = el.getAttribute('data-entity-id') ||
                        el.getAttribute('data-product-id') ||
                        el.getAttribute('data-product-sku') ||
                        el.getAttribute('data-test')?.replace('card-', '');

                    if (productId) {
                        const shouldShow = this.shouldShowPrice(el);

                        if (shouldShow) {
                            if (!el.hasAttribute('data-epicor-processed')) {
                                relatedElements.push(el);
                            }
                        } else {
                            this.hideProductPrice(el);
                            el.setAttribute('data-epicor-processed', 'true');
                        }
                    }
                });
            });

            if (relatedElements.length > 0) {
                await this.processProducts(relatedElements);
            }
        }

        // Set up periodic check for unprocessed products
        setupPeriodicCheck() {
            if (this.periodicCheckInterval) {
                clearInterval(this.periodicCheckInterval);
            }

            this.periodicCheckInterval = setInterval(() => {
                this.checkForUnprocessedProducts();
            }, 2000);
        }

        // Check for unprocessed products
        async checkForUnprocessedProducts() {
            const allProductElements = this.getProductElements();
            const unprocessedElements = Array.from(allProductElements).filter(element =>
                !element.hasAttribute('data-epicor-processed') &&
                this.shouldShowPrice(element) &&
                !this.isQuickViewElement(element)
            );

            if (unprocessedElements.length > 0) {
                await this.processProducts(unprocessedElements);
            }
        }

        // Set up event listeners for slider initialization
        setupSliderEventListeners() {
            document.addEventListener('init.slick', () => {
                setTimeout(() => {
                    this.processRelatedProducts();
                }, 500);
            });

            document.addEventListener('init.carousel', () => {
                setTimeout(() => {
                    this.processRelatedProducts();
                }, 500);
            });

            document.addEventListener('afterChange.slick', () => {
                setTimeout(() => {
                    this.processRelatedProducts();
                }, 100);
            });

            window.addEventListener('resize', () => {
                setTimeout(() => {
                    this.processRelatedProducts();
                }, 1000);
            });
        }

        // Check if current page is cart page
        isCartPage() {
            return window.location.pathname.includes('/cart') ||
                document.querySelector('[data-cart]') !== null ||
                document.querySelector('.cart-page') !== null ||
                document.querySelector('[data-cart-page]') !== null;
        }

        // Show loading then original prices for non-B2B customers
        showLoadingThenOriginalPricesForNonB2B() {
            const priceLoadings = document.querySelectorAll('.price-loading');
            const priceContents = document.querySelectorAll('.price-content');

            priceLoadings.forEach(el => el.style.display = 'block');
            priceContents.forEach(el => el.style.display = 'none');

            setTimeout(() => {
                const productElements = this.getProductElements();

                productElements.forEach(element => {
                    if (this.shouldShowPrice(element)) {
                        const elementPriceLoadings = element.querySelectorAll('.price-loading');
                        const elementPriceContents = element.querySelectorAll('.price-content');

                        elementPriceLoadings.forEach(el => el.style.display = 'none');
                        elementPriceContents.forEach(el => el.style.display = 'block');

                        const hiddenPrices = element.querySelectorAll('.card-text[data-test-info-type="price"]');
                        hiddenPrices.forEach(el => {
                            if (el.style.display === 'none') {
                                el.style.display = '';
                            }
                        });
                    } else {
                        const elementPriceLoadings = element.querySelectorAll('.price-loading');
                        const elementPriceContents = element.querySelectorAll('.price-content');

                        elementPriceLoadings.forEach(el => el.style.display = 'none');
                        elementPriceContents.forEach(el => el.style.display = 'none');

                        const hiddenPrices = element.querySelectorAll('.card-text[data-test-info-type="price"]');
                        hiddenPrices.forEach(el => {
                            el.style.display = 'none';
                        });
                    }
                });
            }, 2000);
        }

        // Get cart ID from various sources
        async getCartId() {
            try {
                const response = await fetch('/api/storefront/cart');
                const data = await response.json();

                if (isArray(data) && data.length > 0) {
                    return data[0].id;
                } else if (data && data.id) {
                    return data.id;
                }
            } catch (error) {
            }

            const urlParams = new URLSearchParams(window.location.search);
            const cartIdFromUrl = urlParams.get('suggest');
            if (cartIdFromUrl) {
                return cartIdFromUrl;
            }

            if (window.cartId) {
                return window.cartId;
            }

            return null;
        }

        // Get cart details using BigCommerce Storefront API
        async getCartDetails(cartId) {
            try {
                const response = await fetch('/api/storefront/cart');
                const data = await response.json();

                if (isArray(data) && data.length > 0) {
                    return data[0];
                } else if (data && data.id) {
                    return data;
                }

                throw new Error('No cart data found');
            } catch (error) {
                return null;
            }
        }

        // Get Epicor price for a specific product
        async getEpicorPriceForProduct(productId, sku) {
            if (!window.b2bCustomerData) {
                return null;
            }

            this.b2bData = window.b2bCustomerData;

            try {
                const requestData = {
                    customer_id: this.b2bData.customer_id,
                    customer_group_code: this.b2bData.customer_group_code,
                    ship_to_num: this.b2bData.ship_to_num || '',
                    product_id: productId.toString(),
                    sku: sku || '',
                    quantity: 1
                };

                const response = await fetch(this.n8nWebhookUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify(requestData)
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                let data;
                try {
                    data = await response.json();
                } catch (jsonError) {
                    return null;
                }

                let epicorPrice = null;
                if (data && data.pricing && data.pricing.netPrice) {
                    epicorPrice = parseFloat(data.pricing.netPrice);
                } else if (data && data.netPrice) {
                    epicorPrice = parseFloat(data.netPrice);
                }

                return epicorPrice;

            } catch (error) {
                return null;
            }
        }

        // Hide all cart prices initially
        hideCartPricesInitially() {
            const selectors = [
                '.cart-item-value',
                '.cart-total-value',
                '.cart-totals .cart-total-value span',
                '.cart-item-block .cart-item-value',
                '.cart-item-block strong.cart-item-value'
            ];

            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    const isShippingButton = el.closest('.shipping-estimate-show') || el.closest('[data-collapsible="add-shipping"]');
                    const isCouponButton = el.closest('.coupon-code-add') || el.closest('.coupon-code-cancel');
                    const isButton = el.tagName === 'BUTTON' || el.closest('button');

                    if (!isShippingButton && !isCouponButton && !isButton) {
                        el.style.opacity = '0';
                        el.style.transition = 'opacity 0.3s ease';
                    }
                });
            });

        }

        // Show loader before updating prices
        showLoaderBeforeUpdate() {
            const loadingOverlay = document.querySelector('.loadingOverlay');
            if (loadingOverlay) {
                loadingOverlay.style.display = 'block';
            }

            if (this.loaderFallbackTimeout) {
                clearTimeout(this.loaderFallbackTimeout);
            }

            this.loaderFallbackTimeout = window.setTimeout(() => {
                this.hideLoaderAfterUpdate();
            }, CONFIG.VIEW_EDIT_CART_LOADER_FALLBACK);
        }

        // Hide loader after updating prices
        hideLoaderAfterUpdate() {
            if (this.loaderFallbackTimeout) {
                clearTimeout(this.loaderFallbackTimeout);
                this.loaderFallbackTimeout = null;
            }

            const loadingOverlay = document.querySelector('.loadingOverlay');
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
            }
        }

        // Show cart prices after Epicor update
        showCartPricesAfterUpdate() {
            const selectors = [
                '.cart-item-value',
                '.cart-total-value',
                '.cart-totals .cart-total-value span',
                '.cart-item-block .cart-item-value',
                '.cart-item-block strong.cart-item-value'
            ];

            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    const isShippingButton = el.closest('.shipping-estimate-show') || el.closest('[data-collapsible="add-shipping"]');
                    const isCouponButton = el.closest('.coupon-code-add') || el.closest('.coupon-code-cancel');
                    const isButton = el.tagName === 'BUTTON' || el.closest('button');

                    if (!isShippingButton && !isCouponButton && !isButton) {
                        el.style.opacity = '1';
                    }
                });
            });

            this.ensureShippingButtonVisibility();
        }

        // Ensure shipping button spans are always visible
        ensureShippingButtonVisibility() {
            const shippingButton = document.querySelector('.shipping-estimate-show');
            if (shippingButton) {
                shippingButton.style.opacity = '1';
                shippingButton.style.transition = 'opacity 0.3s ease';
            }

            const shippingButtonSpans = document.querySelectorAll('.shipping-estimate-show__btn-name, #estimator-add, #estimator-close, .shipping-estimate-show span');
            shippingButtonSpans.forEach(span => {
                span.style.opacity = '1';
                span.style.transition = 'opacity 0.3s ease';
            });
        }

        // Get shipping price from cart or shipping elements
        getShippingPrice() {
            const shippingSelectors = [
                '.shipping-value span',
                '.shipping-cost span',
                '.shipping-total span',
                '.cart-total-shipping span',
                '.shipping .cart-total-value span',
                '[data-shipping-cost]',
                '.shipping-estimate-value'
            ];

            for (const selector of shippingSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    const text = element.textContent || element.innerText || '';
                    const normalized = text.replace(/[^0-9.\-]/g, '');
                    if (!normalized) {
                        continue;
                    }
                    const parsed = parseFloat(normalized);
                    if (!Number.isNaN(parsed)) {
                        return parsed;
                    }
                }
            }

            return 0;
        }

        getCartItemElementById(itemId, fallbackIndex) {
            const selectors = [];
            const normalizedId = itemId != null ? String(itemId) : null;

            if (normalizedId) {
                selectors.push(
                    `tr.cart-item[data-cart-itemid="${normalizedId}"]`,
                    `tr[data-cart-itemid="${normalizedId}"]`,
                    `[data-cart-itemid="${normalizedId}"]`,
                    `[data-item-id="${normalizedId}"]`,
                    `.cart-item[data-item-id="${normalizedId}"]`
                );
            }

            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element) {
                    return element;
                }
            }

            if (typeof fallbackIndex === 'number') {
                const fallbackList = document.querySelectorAll('tr.cart-item, .cart-item');
                if (fallbackList && fallbackList[fallbackIndex]) {
                    return fallbackList[fallbackIndex];
                }
            }

            return null;
        }

        // Update cart prices directly in DOM
        updateCartPricesInDOM(cartItems) {

            this.showLoaderBeforeUpdate();

            cartItems.forEach((item, index) => {
                const epicorPrice = Number(item.epicorPrice) || 0;
                const quantity = Number(item.item?.quantity) || 1;
                const itemTotal = epicorPrice * quantity;
                const itemId = item.item?.id || item.item?.itemId || item.item?.item_id || null;

                const cartItemElement = this.getCartItemElementById(itemId, index);

                if (cartItemElement) {
                    const unitPriceSelectors = [
                        'span.cart-item-value:not(strong)',
                        '.cart-item-value:not(strong)',
                        '[data-cart-item-price]',
                        '.cart-item-price',
                        '[data-product-price]'
                    ];

                    let updatedUnitPrice = false;
                    for (const selector of unitPriceSelectors) {
                        const unitPriceEls = cartItemElement.querySelectorAll(selector);
                        if (unitPriceEls && unitPriceEls.length) {
                            unitPriceEls.forEach(el => {
                                if (el.tagName === 'STRONG') {
                                    return;
                                }
                                el.style.setProperty('opacity', '1');
                                el.textContent = `$${epicorPrice.toFixed(2)}`;
                                updatedUnitPrice = true;
                            });
                            if (updatedUnitPrice) {
                                break;
                            }
                        }
                    }

                    const totalSelectors = [
                        '.cart-item-block.cart-item-info strong.cart-item-value',
                        'strong.cart-item-value',
                        '.cart-item-total',
                        '.item-total'
                    ];

                    let updatedTotal = false;
                    for (const selector of totalSelectors) {
                        const totalEl = cartItemElement.querySelector(selector);
                        if (totalEl && !updatedTotal) {
                            totalEl.style.setProperty('opacity', '1');
                            totalEl.textContent = `$${itemTotal.toFixed(2)}`;
                            updatedTotal = true;
                        }
                    }

                    if (!updatedUnitPrice || !updatedTotal) {
                        const fallbackPriceEls = document.querySelectorAll('span.cart-item-value:not(strong), .cart-item-value:not(strong)');
                        if (fallbackPriceEls && fallbackPriceEls[index]) {
                            fallbackPriceEls[index].style.setProperty('opacity', '1');
                            fallbackPriceEls[index].textContent = `$${epicorPrice.toFixed(2)}`;
                        }

                        const fallbackTotals = document.querySelectorAll('.cart-item-block.cart-item-info strong.cart-item-value, strong.cart-item-value');
                        if (fallbackTotals && fallbackTotals[index]) {
                            fallbackTotals[index].style.setProperty('opacity', '1');
                            fallbackTotals[index].textContent = `$${itemTotal.toFixed(2)}`;
                        }
                    }
                } else {
                    const fallbackPriceEls = document.querySelectorAll('span.cart-item-value:not(strong), .cart-item-value:not(strong)');
                    if (fallbackPriceEls && fallbackPriceEls[index]) {
                        fallbackPriceEls[index].style.setProperty('opacity', '1');
                        fallbackPriceEls[index].textContent = `$${epicorPrice.toFixed(2)}`;
                    }

                    const fallbackTotals = document.querySelectorAll('.cart-item-block.cart-item-info strong.cart-item-value, strong.cart-item-value');
                    if (fallbackTotals && fallbackTotals[index]) {
                        fallbackTotals[index].style.setProperty('opacity', '1');
                        fallbackTotals[index].textContent = `$${itemTotal.toFixed(2)}`;
                    }
                }
            });

            const totalPrice = cartItems.reduce((sum, item) => {
                const epicorPrice = Number(item.epicorPrice) || 0;
                const quantity = Number(item.item?.quantity) || 1;
                return sum + (epicorPrice * quantity);
            }, 0);

            const subtotalSelectors = [
                '[data-cart-totals-subtotal]',
                '.cart-totals .cart-total-value span',
                '.cart-total-value span',
                '.subtotal span',
                '.cart-subtotal span',
                '[data-cart-subtotal]'
            ];

            subtotalSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    const isShippingButton = el.closest('.shipping-estimate-show') || el.closest('[data-collapsible="add-shipping"]');
                    const isCouponButton = el.closest('.coupon-code-add') || el.closest('.coupon-code-cancel');
                    const isGrandTotal = el.closest('.cart-total-grandTotal') || el.closest('.grand-total');
                    const isButton = el.tagName === 'BUTTON' || el.closest('button');

                    if (!isShippingButton && !isCouponButton && !isGrandTotal && !isButton) {
                        el.style.setProperty('opacity', '1');
                        el.textContent = `$${totalPrice.toFixed(2)}`;
                    }
                });
            });

            const shippingPrice = this.getShippingPrice();
            const grandTotal = totalPrice + shippingPrice;

            const grandTotalSelectors = [
                '.cart-total-grandTotal span',
                '.cart-total-value.cart-total-grandTotal span',
                '.grand-total span',
                '.total-grand span',
                '[data-cart-total]'
            ];

            grandTotalSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    const isShippingButton = el.closest('.shipping-estimate-show') || el.closest('[data-collapsible="add-shipping"]');
                    const isCouponButton = el.closest('.coupon-code-add') || el.closest('.coupon-code-cancel');
                    const isButton = el.tagName === 'BUTTON' || el.closest('button');

                    if (!isShippingButton && !isCouponButton && !isButton) {
                        el.style.setProperty('opacity', '1');
                        el.textContent = `$${grandTotal.toFixed(2)}`;
                    }
                });
            });

            this.showCartPricesAfterUpdate();

            this.hideLoaderAfterUpdate();
        }

        // Process cart with Epicor pricing
        async processCartWithEpicorPricing() {
            try {
                this.hideCartPricesInitially();

                this.ensureShippingButtonVisibility();

                this.showLoaderBeforeUpdate();

                if (!window.b2bCustomerData) {
                    setTimeout(() => {
                        this.showCartPricesAfterUpdate();
                        this.hideLoaderAfterUpdate();
                    }, 2000);
                    this.isCartPricingComplete = true;
                    return null;
                }

                this.b2bData = window.b2bCustomerData;

                const cartId = await this.getCartId();
                if (!cartId) {
                    return null;
                }

                const cartDetails = await this.getCartDetails(cartId);
                if (!cartDetails || !cartDetails.lineItems || !cartDetails.lineItems.physicalItems) {
                    return null;
                }

                const physicalItems = cartDetails.lineItems.physicalItems;

                const results = [];

                for (const item of physicalItems) {
                    const productId = item.product_id || item.productId;
                    const variantId = item.variant_id || item.variantId;

                    const epicorPrice = await this.getEpicorPriceForProduct(productId, item.sku);

                    if (epicorPrice) {
                        results.push({
                            item: item,
                            epicorPrice: epicorPrice,
                            productId: productId,
                            variantId: variantId,
                            sku: item.sku
                        });
                    }
                }

                if (results.length > 0) {
                    this.updateCartPricesInDOM(results);

                    await this.sendAllCartItemsToN8N(cartId, results);
                }

                return results;

            } catch (error) {
                this.showCartPricesAfterUpdate();
                this.hideLoaderAfterUpdate();
                this.isCartPricingComplete = true;
                return null;
            } finally {
                this.isCartPricingComplete = true;
            }
        }

        // Send cart items to N8N one by one
        async sendAllCartItemsToN8N(cartId, cartItems) {
            if (!cartItems || cartItems.length === 0) {
                return;
            }

            for (let i = 0; i < cartItems.length; i++) {
                const result = cartItems[i];

                try {
                    const n8nPayload = {
                        action: 'update_cart_prices',
                        cart_id: cartId,
                        cart_item: {
                            item_id: result.item.id,
                            product_id: result.productId,
                            variant_id: result.variantId,
                            sku: result.item.sku,
                            name: result.item.name,
                            quantity: result.item.quantity,
                            epicor_price: result.epicorPrice,
                            original_price: result.item.list_price || result.item.originalPrice
                        },
                        store_hash: CONFIG.BIGCOMMERCE_STORE_HASH,
                        auth_token: CONFIG.BIGCOMMERCE_AUTH_TOKEN,
                        item_number: i + 1,
                        total_items: cartItems.length
                    };

                    const response = await fetch(this.n8nCartWebhookUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(n8nPayload)
                    });

                    if (i < cartItems.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }

                } catch (error) {
                }
            }

            markCartUpdateStart();

            await new Promise(resolve => setTimeout(resolve, 2000));

            const updatedCartData = await this.getCartDetails(cartId);

            if (updatedCartData && updatedCartData.lineItems && updatedCartData.lineItems.physicalItems) {
                this.updateCartPricesFromCartData(updatedCartData);
            }

            markCartUpdateComplete();
        }

        // Update cart prices from refreshed cart data
        updateCartPricesFromCartData(cartData) {

            let totalPrice = 0;

            if (cartData.lineItems && cartData.lineItems.physicalItems) {

                cartData.lineItems.physicalItems.forEach((item, index) => {

                    const itemPrice = item.listPrice || item.list_price || item.originalPrice || item.original_price || item.salePrice || item.sale_price || 0;
                    const itemTotal = item.extendedListPrice || item.extended_list_price || item.extendedSalePrice || item.extended_sale_price || (itemPrice * item.quantity);
                    const itemId = item.id;

                    const cartItemSelectors = [
                        `tr.cart-item[data-cart-itemid="${itemId}"]`,
                        `tr[data-cart-itemid="${itemId}"]`,
                        `[data-cart-itemid="${itemId}"]`,
                        `[data-item-id="${itemId}"]`,
                        `.cart-item[data-item-id="${itemId}"]`,
                        `.cart-item:nth-child(${index + 1})`
                    ];

                    let cartItemElement = null;
                    for (const selector of cartItemSelectors) {
                        cartItemElement = document.querySelector(selector);
                        if (cartItemElement) break;
                    }

                    if (cartItemElement) {
                        const priceSelectors = [
                            'span.cart-item-value:not(strong)',
                            '.cart-item-value:not(strong)',
                            'span.cart-item-value',
                            '.cart-item-block.cart-item-info .cart-item-value:not(strong)',
                            '[data-product-price]',
                            '.price'
                        ];

                        for (const selector of priceSelectors) {
                            const priceElements = cartItemElement.querySelectorAll(selector);
                            for (const priceElement of priceElements) {
                                if (priceElement.tagName !== 'STRONG' && !priceElement.querySelector('strong')) {
                                    priceElement.textContent = `$${itemPrice.toFixed(2)}`;
                                    priceElement.style.opacity = '1';

                                    const loadingText = priceElement.parentNode.querySelector('.loading-text');
                                    if (loadingText) {
                                        loadingText.remove();
                                    }
                                }
                            }
                        }

                        const totalSelectors = [
                            '.cart-item-block.cart-item-info strong.cart-item-value',
                            'strong.cart-item-value',
                            '.cart-item-total',
                            '.item-total'
                        ];

                        for (const selector of totalSelectors) {
                            const totalElement = cartItemElement.querySelector(selector);
                            if (totalElement) {
                                totalElement.textContent = `$${itemTotal.toFixed(2)}`;
                                totalElement.style.opacity = '1';

                                const loadingText = totalElement.parentNode.querySelector('.loading-text');
                                if (loadingText) {
                                    loadingText.remove();
                                }

                                break;
                            }
                        }

                        totalPrice += itemTotal;
                    }
                });
            }

            if (totalPrice === 0 || isNaN(totalPrice)) {
                totalPrice = cartData.cartAmount || cartData.baseAmount || 0;
            }

            const subtotalSelectors = [
                '.cart-totals .cart-total-value span',
                '.cart-totals .cart-total-value',
                '.subtotal span',
                '.cart-subtotal span',
                '[data-cart-subtotal]',
                '.cart-total-value:not(.cart-total-grandTotal) span'
            ];

            for (const selector of subtotalSelectors) {
                const subtotalElement = document.querySelector(selector);
                if (subtotalElement && !subtotalElement.closest('.cart-total-grandTotal')) {
                    const isShippingButton = subtotalElement.closest('.shipping-estimate-show') || subtotalElement.closest('[data-collapsible="add-shipping"]');
                    const isCouponButton = subtotalElement.closest('.coupon-code-add') || subtotalElement.closest('.coupon-code-cancel');
                    const isButton = subtotalElement.tagName === 'BUTTON' || subtotalElement.closest('button');

                    if (!isShippingButton && !isCouponButton && !isButton) {
                        subtotalElement.textContent = `$${totalPrice.toFixed(2)}`;
                        subtotalElement.style.opacity = '1';
                        break;
                    }
                }
            }

            const shippingPrice = this.getShippingPrice();
            const grandTotal = totalPrice + shippingPrice;

            const grandTotalSelectors = [
                '.cart-total-value.cart-total-grandTotal span',
                '.cart-total-grandTotal span',
                '.grand-total span',
                '.total-grand span',
                '[data-cart-total]',
                '.cart-total-value:last-child span'
            ];

            for (const selector of grandTotalSelectors) {
                const grandTotalElement = document.querySelector(selector);
                if (grandTotalElement) {
                    const isShippingButton = grandTotalElement.closest('.shipping-estimate-show') || grandTotalElement.closest('[data-collapsible="add-shipping"]');
                    const isCouponButton = grandTotalElement.closest('.coupon-code-add') || grandTotalElement.closest('.coupon-code-cancel');
                    const isButton = grandTotalElement.tagName === 'BUTTON' || grandTotalElement.closest('button');

                    if (!isShippingButton && !isCouponButton && !isButton) {
                        grandTotalElement.textContent = `$${grandTotal.toFixed(2)}`;
                        grandTotalElement.style.opacity = '1';
                        break;
                    }
                }
            }

        }

        // Initialize cart pricing if on cart page
        initCartPricing() {
            if (this.isCartPage()) {

                this.hideCartPricesInitially();

                this.ensureShippingButtonVisibility();

                const checkB2BData = () => {
                    if (this.b2bData) {
                        this.processCartWithEpicorPricing();
                    } else {
                        setTimeout(checkB2BData, 1000);
                    }
                };

                checkB2BData();
            }
        }
    }

    window.EpicorN8NPricing = new EpicorN8NPricing();

    setupViewEditCartNavigationGuard();

    document.addEventListener('DOMContentLoaded', function() {

        if (!window.isB2BCustomer) {
            window.EpicorN8NPricing.init();
        } else {
        }

        if (window.EpicorN8NPricing.isCartPage()) {
        }
    });

    window.addEventListener('popstate', function() {
        setTimeout(() => {
            if (!window.isB2BCustomer) {
                window.EpicorN8NPricing.init();
            } else if (window.b2bCustomerData) {
                window.EpicorN8NPricing.updateAllPagePrices();
            }
        }, 100);
    });

    window.addEventListener('statechange', function() {
        setTimeout(() => {
            if (window.b2bCustomerData) {
                window.EpicorN8NPricing.updateAllPagePrices();
            } else {
                if (window.EpicorN8NPricing) {
                    window.EpicorN8NPricing.showLoadingThenOriginalPricesForNonB2B();
                }
            }
        }, 500);
    });

    if (window.hooks) {
        window.hooks.on('facetedSearch-content-updated', function() {
            setTimeout(() => {
                if (window.b2bCustomerData) {
                    window.EpicorN8NPricing.updateAllPagePrices();
                } else {
                    if (window.EpicorN8NPricing) {
                        window.EpicorN8NPricing.showLoadingThenOriginalPricesForNonB2B();
                    }
                }
            }, 300);
        });
    }

    document.addEventListener('click', function(event) {
        if (event.target && typeof event.target.matches === 'function' &&
            event.target.matches('.pagination-link, .pagination-item a, .pagination-item--next a, .pagination-item--previous a')) {
        }
    });

    let currentUrl = window.location.href;
    setInterval(() => {
        if (window.location.href !== currentUrl) {
            currentUrl = window.location.href;
            setTimeout(() => {
                if (window.b2bCustomerData) {
                    window.EpicorN8NPricing.updateAllPagePrices();
                } else {
                    if (window.EpicorN8NPricing) {
                        window.EpicorN8NPricing.showLoadingThenOriginalPricesForNonB2B();
                    }
                }
            }, 500);
        }
    }, 1000);

    if (window.MutationObserver) {
        const observer = new MutationObserver(function(mutations) {
            let shouldRefresh = false;

            mutations.forEach(function(mutation) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(function(node) {
                        if (node.nodeType === 1) {
                            const productElements = node.querySelectorAll ?
                                node.querySelectorAll('[data-product-sku], [data-entity-id], .card, .listItem, .product') : [];

                            if (productElements.length > 0 ||
                                node.matches('[data-product-sku], [data-entity-id], .card, .listItem, .product')) {
                                shouldRefresh = true;
                            }
                        }
                    });
                }
            });

            if (shouldRefresh) {
                setTimeout(() => {
                    if (window.b2bCustomerData) {
                        window.EpicorN8NPricing.updateAllPagePrices();
                    } else {
                        if (window.EpicorN8NPricing) {
                            window.EpicorN8NPricing.showLoadingThenOriginalPricesForNonB2B();
                        }
                    }
                }, 300);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

    } else {
    }

    window.refreshEpicorPrices = function() {
        if (window.b2bCustomerData && window.EpicorN8NPricing) {
            window.EpicorN8NPricing.updateAllPagePrices();
        }
    };

    window.processCartWithEpicorPricing = function() {
        if (window.EpicorN8NPricing) {
            return window.EpicorN8NPricing.processCartWithEpicorPricing();
        } else {
            return null;
        }
    };

    const checkB2BDataInterval = setInterval(() => {
        if (window.b2bCustomerData && window.EpicorN8NPricing) {
            window.EpicorN8NPricing.b2bData = window.b2bCustomerData;

            if (window.EpicorN8NPricing.isCartPage()) {
                window.EpicorN8NPricing.processCartWithEpicorPricing();
            }

            clearInterval(checkB2BDataInterval);
        }
    }, 500);

    setTimeout(() => {
        clearInterval(checkB2BDataInterval);
    }, 30000);

    window.testEpicorPricing = function() {
        window.EpicorN8NPricing.updateAllPagePrices();
    };

    window.setB2BDataAndProcessCart = function(b2bData) {
        if (window.EpicorN8NPricing) {
            window.EpicorN8NPricing.b2bData = b2bData;
            window.b2bCustomerData = b2bData;

            if (window.EpicorN8NPricing.isCartPage()) {
                return window.EpicorN8NPricing.processCartWithEpicorPricing();
            } else {
                return Promise.resolve();
            }
        } else {
            return null;
        }
    };

    window.checkForNewProducts = function() {
        if (window.EpicorN8NPricing) {
            window.EpicorN8NPricing.checkForNewProducts();
        }
    };

    setInterval(() => {
        if (window.b2bCustomerData && window.EpicorN8NPricing) {
            window.EpicorN8NPricing.checkForNewProducts();
        }
    }, 2000);

    const quickviewRequestCache = new Map();

    document.addEventListener('click', function(event) {
        if (!event.target || typeof event.target.closest !== 'function') return;

        const quickviewBtn = event.target.closest('.quickview');
        if (!quickviewBtn) return;

        const isB2B = window.b2bCustomerData || window.isB2BCustomer;

        const intervalId = setInterval(() => {
            const modal = document.querySelector('#modal.open .productView, #modal.is-open .productView, .modal.open .productView, .modal.is-open .productView');
            if (!modal) {
                return;
            }

            clearInterval(intervalId);

            const epicorInstance = window.EpicorN8NPricing;
            const modalPriceLoadingEls = modal.querySelectorAll('.price-loading');
            const modalPriceContentEls = modal.querySelectorAll('.price-content');

            modalPriceLoadingEls.forEach(el => (el.style.display = 'block'));
            modalPriceContentEls.forEach(el => (el.style.display = 'block'));

            let actualProductId = epicorInstance?.getNumericProductId(modal) ||
                epicorInstance?.getNumericProductId(quickviewBtn) || null;

            if (!actualProductId) {
                const hiddenInput = modal.querySelector('input[name="product_id"]');
                if (hiddenInput && hiddenInput.value && /^\d+$/.test(hiddenInput.value.trim())) {
                    actualProductId = hiddenInput.value.trim();
                }
            }

            if (!actualProductId) {
                modalPriceLoadingEls.forEach(el => (el.style.display = 'none'));
                return;
            }

            const cacheKey = `quickview-${actualProductId}`;
            if (quickviewRequestCache.has(cacheKey)) {
                modalPriceLoadingEls.forEach(el => (el.style.display = 'none'));
                return;
            }

            quickviewRequestCache.set(cacheKey, true);

            setTimeout(() => {
                const mainPriceSection = modal.querySelector('.price-section--withoutTax.price--withoutTax');
                if (!mainPriceSection) {
                    modalPriceLoadingEls.forEach(el => (el.style.display = 'none'));
                    quickviewRequestCache.delete(cacheKey);
                    return;
                }

                mainPriceSection.style.display = 'block';
                const priceEl = mainPriceSection.querySelector('.price');
                if (!priceEl) {
                    modalPriceLoadingEls.forEach(el => (el.style.display = 'none'));
                    quickviewRequestCache.delete(cacheKey);
                    return;
                }

                if (!priceEl.getAttribute('data-original-price')) {
                    priceEl.setAttribute('data-original-price', priceEl.textContent.trim());
                }

                priceEl.textContent = 'Loading...';
                priceEl.setAttribute('data-epicor-loading', 'true');

                const sku = epicorInstance?.getSkuFromElement(modal) ||
                    quickviewBtn.dataset.productSku ||
                    '';

                if (isB2B && epicorInstance && window.b2bCustomerData) {
                    const productData = { product_id: actualProductId.toString(), quantity: 1, sku };
                    const customerData = window.b2bCustomerData;

                    epicorInstance.getPriceFromN8N(customerData, productData)
                        .then(pricing => {
                            if (pricing && pricing.valid && pricing.netPrice) {
                                const formattedPrice = epicorInstance.formatPrice(pricing.netPrice, pricing.currency);
                                priceEl.textContent = formattedPrice;
                            } else {
                                const fallback = priceEl.getAttribute('data-original-price') || 'Price Unavailable';
                                priceEl.textContent = fallback;
                            }
                        })
                        .catch(() => {
                            const fallback = priceEl.getAttribute('data-original-price') || 'Price Unavailable';
                            priceEl.textContent = fallback;
                        })
                        .finally(() => {
                            priceEl.removeAttribute('data-epicor-loading');
                            modalPriceLoadingEls.forEach(el => (el.style.display = 'none'));
                            setTimeout(() => quickviewRequestCache.delete(cacheKey), 500);
                        });
                } else {
                    setTimeout(() => {
                        const originalPrice = priceEl.getAttribute('data-original-price') || priceEl.textContent;
                        priceEl.textContent = originalPrice;
                        priceEl.removeAttribute('data-epicor-loading');
                        modalPriceLoadingEls.forEach(el => (el.style.display = 'none'));
                        quickviewRequestCache.delete(cacheKey);
                    }, 1000);
                }
            }, 100);

            setTimeout(() => {
                setupQuickviewAddToCartListener(modal, actualProductId);
            }, 1000);
        }, 200);
    });

    function setupQuickviewAddToCartListener(modal, productId) {
        const addToCartForms = modal.querySelectorAll('form[data-cart-item-add]');

        addToCartForms.forEach(function(form) {
            form.addEventListener('submit', function(e) {
                checkB2BAndUpdateCartQuickview(form, e, productId);
            });
        });
    }

    async function checkB2BAndUpdateCartQuickview(form, event, productId) {
        try {
            if (window.EpicorN8NPricing?.isB2BCustomer()) {
                const isB2B = window.EpicorN8NPricing.isB2BCustomer();

                if (isB2B) {
                    markN8NProcessingStart();

                    setTimeout(() => {
                        updateCartViaN8NAfterAddQuickview(form, productId);
                    }, 2000);
                }
            }

        } catch (error) {
            markN8NProcessingComplete();
        }
    }

    async function updateCartViaN8NAfterAddQuickview(form, productId) {
        try {
            const quantity = form.querySelector('input[name="qty[]"]') ?
                form.querySelector('input[name="qty[]"]').value : 1;

            let actualProductId = productId;
            const modal = form.closest('.productView');
            if (modal) {
                const modalProductId = modal.getAttribute('data-product-id') ||
                    modal.getAttribute('data-entity-id') ||
                    modal.querySelector('[data-product-id]')?.getAttribute('data-product-id');
                if (modalProductId && /^\d+$/.test(modalProductId.trim())) {
                    actualProductId = modalProductId.trim();
                }
            }

            if (!actualProductId || !/^\d+$/.test(actualProductId)) {
                const hiddenIdInput = form.querySelector('input[name="product_id"]') ||
                    form.querySelector('[name="product_id"]');
                if (hiddenIdInput && hiddenIdInput.value && /^\d+$/.test(hiddenIdInput.value.trim())) {
                    actualProductId = hiddenIdInput.value.trim();
                }
            }

            const skuElement = form.querySelector('[data-product-sku]') ||
                form.closest('.productView')?.querySelector('[data-product-sku]');
            let sku = '';
            if (skuElement) {
                sku = skuElement.getAttribute('data-product-sku') ||
                    skuElement.textContent?.trim() ||
                    '';
                if (!sku && skuElement.textContent) {
                    const skuMatch = skuElement.textContent.match(/SKU#?\s*([^\s]+)/i);
                    if (skuMatch) {
                        sku = skuMatch[1];
                    }
                }
            }

            if (!sku) {
                markN8NProcessingComplete();
                markCartUpdateComplete();
                return;
            }

            if (!actualProductId || !/^\d+$/.test(actualProductId)) {
                markN8NProcessingComplete();
                markCartUpdateComplete();
                return;
            }

            const cartId = await getCartIdQuickview();
            if (!cartId) {
                markN8NProcessingComplete();
                markCartUpdateComplete();
                return;
            }

            let epicorPrice = null;
            if (window.EpicorN8NPricing && window.EpicorN8NPricing.getEpicorPriceForProduct) {
                epicorPrice = await window.EpicorN8NPricing.getEpicorPriceForProduct(actualProductId, sku);
            }

            if (!epicorPrice) {
                markN8NProcessingComplete();
                markCartUpdateComplete();
                return;
            }

            markCartUpdateStart();

            const success = await updateCartPriceViaN8NQuickview(cartId, actualProductId, sku, quantity, epicorPrice);

            markN8NProcessingComplete();

            if (success) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            markCartUpdateComplete();

        } catch (error) {
            markN8NProcessingComplete();
            markCartUpdateComplete();
        }
    }

    function stopBigCommerceLoader() {
        try {
            const loadingOverlay = document.querySelector('.loadingOverlay');
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
            }

            const modalLoaders = document.querySelectorAll('.modal .loadingOverlay');
            modalLoaders.forEach(loader => {
                loader.style.display = 'none';
            });

            const modalContent = document.querySelector('.modal .modal-content');
            if (modalContent) {
                modalContent.style.display = 'block';
            }

            if (window.$ && window.$.fn && window.$.fn.reveal) {
                window.$('.modal').foundation('close');
            }

            const stopLoaderEvent = new CustomEvent('stopLoader');
            document.dispatchEvent(stopLoaderEvent);

        } catch (error) {
        }
    }

    function waitForN8NProcessingToFinish(options = {}) {
        const normalizedOptions = typeof options === 'number' ? { timeoutMs: options } : options;
        const {
            timeoutMs = CONFIG.VIEW_EDIT_CART_MAX_WAIT,
            minWaitMs = CONFIG.VIEW_EDIT_CART_MIN_SPIN,
            checkIntervalMs = CONFIG.N8N_STATUS_CHECK_INTERVAL
        } = normalizedOptions;

        return new Promise((resolve) => {
            const start = Date.now();
            const deadline = start + timeoutMs;
            const earliestRelease = start + Math.max(0, minWaitMs || 0);
            const interval = Math.max(25, checkIntervalMs || 25);
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
                const status = window.N8NProcessingStatus;

                const stillProcessing = Boolean(status && (
                    status.inProgress ||
                    !status.completed ||
                    (status.cartUpdateStartTime && !status.cartUpdateComplete)
                ));

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

    function isViewEditCartTrigger(element) {
        if (!element) {
            return false;
        }

        const selectors = [
            '.dropdown-menu-button--viewCart',
            '.button--viewCart',
            '.button--view-cart',
            '.previewCart-action .button',
            '[data-view-edit-cart]',
            'a[href="/cart.php"], button[href="/cart.php"]'
        ];

        if (selectors.some(selector => element.matches(selector))) {
            return true;
        }

        const href = element.getAttribute('href') || element.dataset?.href || element.dataset?.destination;
        if (!href) {
            return false;
        }

        return /cart\.php(?:$|[?#])/i.test(href);
    }

    function setupViewEditCartNavigationGuard() {
        document.addEventListener('click', function(event) {
            const trigger = event.target.closest('a, button');
            if (!trigger || !isViewEditCartTrigger(trigger)) {
                return;
            }

            ensureN8NProcessingStatus();
            const status = window.N8NProcessingStatus;
            if (!status) {
                return;
            }

            const isB2BCustomer = Boolean(window.EpicorN8NPricing?.isB2BCustomer?.());
            const shouldIntercept = isB2BCustomer || status.inProgress || status.awaitingCartNavigation || status.cartUpdateStartTime;

            if (!shouldIntercept) {
                return;
            }

            event.preventDefault();

            if (status.awaitingCartNavigation) {
                return;
            }

            (async () => {
                status.awaitingCartNavigation = true;

                const wantsNewTab = event.metaKey || event.ctrlKey || trigger.getAttribute('target') === '_blank';
                let destination = trigger.getAttribute('href') || trigger.dataset?.href || trigger.dataset?.destination || '/cart.php';
                if (!destination || destination === '#') {
                    destination = '/cart.php';
                }

                if (window.EpicorN8NPricing && typeof window.EpicorN8NPricing.showLoaderBeforeUpdate === 'function') {
                    window.EpicorN8NPricing.showLoaderBeforeUpdate();
                }

                const waitResult = await waitForN8NProcessingToFinish({
                    timeoutMs: Math.max(CONFIG.VIEW_EDIT_CART_MAX_WAIT, CONFIG.VIEW_EDIT_CART_MIN_SPIN),
                    minWaitMs: CONFIG.VIEW_EDIT_CART_MIN_SPIN,
                    checkIntervalMs: CONFIG.N8N_STATUS_CHECK_INTERVAL
                });

                if (waitResult.completed) {
                    await sleep(CONFIG.VIEW_EDIT_CART_POST_COMPLETION_DELAY);
                } else if (waitResult.timedOut) {
                    markN8NProcessingComplete();
                    markCartUpdateComplete();
                }

                if (window.EpicorN8NPricing && typeof window.EpicorN8NPricing.hideLoaderAfterUpdate === 'function') {
                    window.EpicorN8NPricing.hideLoaderAfterUpdate();
                }

                if (typeof stopBigCommerceLoader === 'function') {
                    stopBigCommerceLoader();
                }

                status.awaitingCartNavigation = false;

                if (wantsNewTab) {
                    const targetAttr = trigger.getAttribute('target') || '_blank';
                    window.open(destination, targetAttr);
                } else {
                    await sleep(100);
                    window.location.assign(destination);
                }
            })().catch(() => {
                status.awaitingCartNavigation = false;
                if (window.EpicorN8NPricing && typeof window.EpicorN8NPricing.hideLoaderAfterUpdate === 'function') {
                    window.EpicorN8NPricing.hideLoaderAfterUpdate();
                }
                if (typeof stopBigCommerceLoader === 'function') {
                    stopBigCommerceLoader();
                }
                markN8NProcessingComplete();
                markCartUpdateComplete();
            });
        }, true);
    }

    async function getCartIdQuickview() {
        try {
            const response = await fetch('/api/storefront/cart');
            const data = await response.json();
            if (isArray(data) && data.length > 0) {
                return data[0].id;
            } else if (data && data.id) {
                return data.id;
            }
        } catch (error) {
        }
        return null;
    }

    async function updateCartPriceViaN8NQuickview(cartId, productId, sku, quantity, epicorPrice) {
        try {
            const cartItemDetails = await getCartItemDetailsQuickview(cartId, productId, sku);

            if (!cartItemDetails) {
                return false;
            }

            const n8nPayload = {
                action: 'update_cart_prices',
                cart_id: cartId,
                cart_item: {
                    item_id: cartItemDetails.id,
                    product_id: productId,
                    variant_id: cartItemDetails.variantId || cartItemDetails.variant_id,
                    sku: sku,
                    name: cartItemDetails.name,
                    quantity: quantity,
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
                return false;
            }

            const data = await response.json();
            const success = data.success !== false;

            stopBigCommerceLoader();

            const modalLoaders = document.querySelectorAll('.modal .loadingOverlay');
            modalLoaders.forEach(loader => {
                loader.style.display = 'none';
            });

            return success;

        } catch (error) {
            stopBigCommerceLoader();

            const modalLoaders = document.querySelectorAll('.modal .loadingOverlay');
            modalLoaders.forEach(loader => {
                loader.style.display = 'none';
            });

            return false;
        }
    }

    async function getCartItemDetailsQuickview(cartId, productId, sku) {
        try {
            const response = await fetch(`/api/storefront/checkouts/${cartId}`);
            if (!response.ok) {
                return await getCartItemDetailsFallbackQuickview(productId, sku);
            }

            const checkoutData = await response.json();

            let physicalItems = null;

            if (checkoutData.cart && checkoutData.cart.line_items && checkoutData.cart.line_items.physical_items) {
                physicalItems = checkoutData.cart.line_items.physical_items;
            } else if (checkoutData.cart && checkoutData.cart.lineItems && checkoutData.cart.lineItems.physicalItems) {
                physicalItems = checkoutData.cart.lineItems.physicalItems;
            } else if (checkoutData.line_items && checkoutData.line_items.physical_items) {
                physicalItems = checkoutData.line_items.physical_items;
            } else if (checkoutData.lineItems && checkoutData.lineItems.physicalItems) {
                physicalItems = checkoutData.lineItems.physicalItems;
            }

            if (!physicalItems || !isArray(physicalItems)) {
                console.error('Could not find physical items in checkout data');
                return await getCartItemDetailsFallbackQuickview(productId, sku);
            }

            let matchingItem = null;
            let latestTime = 0;

            for (const item of physicalItems) {
                const itemProductId = item.productId || item.product_id;
                const itemSku = item.sku;

                if (itemProductId == productId && itemSku === sku) {
                    const itemTime = new Date(item.createdTime || item.created_time || item.updatedTime || item.updated_time || Date.now()).getTime();
                    if (itemTime > latestTime) {
                        latestTime = itemTime;
                        matchingItem = item;
                    }
                }
            }

            if (matchingItem) {
                return matchingItem;
            }

            return await getCartItemDetailsFallbackQuickview(productId, sku);

        } catch (error) {
            return await getCartItemDetailsFallbackQuickview(productId, sku);
        }
    }

    async function getCartItemDetailsFallbackQuickview(productId, sku) {
        try {
            const response = await fetch('/api/storefront/cart');
            if (!response.ok) {
                return null;
            }

            const cartData = await response.json();

            let items = null;

            if (isArray(cartData)) {
                const cart = cartData[0];
                if (cart && cart.line_items && cart.line_items.physical_items) {
                    items = cart.line_items.physical_items;
                } else if (cart && cart.lineItems && cart.lineItems.physicalItems) {
                    items = cart.lineItems.physicalItems;
                }
            } else if (cartData.line_items && cartData.line_items.physical_items) {
                items = cartData.line_items.physical_items;
            } else if (cartData.lineItems && cartData.lineItems.physicalItems) {
                items = cartData.lineItems.physicalItems;
            } else if (cartData.items) {
                items = cartData.items;
            }

            if (!items || !isArray(items)) {
                console.error('Could not find items in cart data');
                return null;
            }

            let matchingItem = null;
            let latestTime = 0;

            for (const item of items) {
                const itemProductId = item.productId || item.product_id;
                const itemSku = item.sku;

                if (itemProductId == productId && itemSku === sku) {
                    const itemTime = new Date(item.createdTime || item.created_time || item.updatedTime || item.updated_time || Date.now()).getTime();
                    if (itemTime > latestTime) {
                        latestTime = itemTime;
                        matchingItem = item;
                    }
                }
            }

            if (matchingItem) {
                return matchingItem;
            } else {
                return null;
            }

        } catch (error) {
            return null;
        }
    }
})();

