/**
 * n8n Function node
 * Input: one item whose json matches the structure you posted (storeDetails, order, shipments, productImages, catalogProducts, etc.)
 * Output: subject, preheader, html (final BigCommerce-style email)
 */

const payload = items[0]?.json || {};
const order = payload.order;
if (!order) {
	throw new Error('order payload is required');
}

const storeDetails = payload.storeDetails || {};
const shipments = payload.shipments || [];
const readyForPickupProducts = payload.readyForPickupProducts || [];
const pickedUpProducts = payload.pickedUpProducts || [];
const shippedProducts = payload.shippedProducts || [];
const unshippedProducts = payload.unshippedProducts || [];
const downloadableProducts = payload.downloadableProducts || [];
const orderProducts = payload.orderProducts || [];
const catalogProducts = payload.catalogProducts || {};
const productImages = payload.productImages || {};
const orderLink = payload.orderLink || '';

const escapeHtml = (value) =>
	value === null || value === undefined
		? ''
		: String(value)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');

const toNumber = (value) => {
	const num = Number(value);
	return Number.isNaN(num) ? 0 : num;
};

const locale = order.customer_locale || storeDetails.language || 'en-US';
const currency =
	order.currency_code ||
	order.store_default_currency_code ||
	storeDetails.currency ||
	'USD';

const formatCurrency = (value) =>
	new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
		toNumber(value),
	);

const timezone =
	storeDetails.timezone && typeof storeDetails.timezone.name === 'string'
		? storeDetails.timezone.name
		: undefined;

const formatDate = (value) => {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return escapeHtml(value);
	}
	return date.toLocaleString(locale, {
		timeZone: timezone,
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
};

const extractEpicorId = (externalId) => {
	if (!externalId) return '';
	const parts = String(externalId).split(':');
	return parts.length > 1 ? parts[1].trim() : '';
};

const collectAttributes = (product) => {
	const options = product.product_options || product.attribute_lines || [];
	return options
		.map((option) => {
			const key = option.display_name || option.name;
			const value = option.display_value || option.value;
			if (!key || value === undefined || value === null) return '';
			return `${escapeHtml(key)}: ${escapeHtml(value)}`;
		})
		.filter(Boolean);
};

const lookupImage = (productId) => {
	const images = productImages[productId];
	if (Array.isArray(images) && images.length) {
		const image = images[0];
		return image.url_standard || image.url_thumbnail || image.url_zoom || '';
	}
	return '';
};

const normalizeProduct = (product, overrideQty) => {
	const quantityCandidate =
		overrideQty !== undefined && overrideQty !== null
			? overrideQty
			: product.quantity || 0;

	const quantity = Math.max(toNumber(quantityCandidate), 0);

	const thumbnail =
		product.thumbnail ||
		product.product_image_url ||
		product.image_url ||
		lookupImage(product.product_id);

	return {
		name: escapeHtml(product.name),
		sku: escapeHtml(product.sku),
		brand: escapeHtml(product.brand),
		quantity,
		thumbnail: escapeHtml(thumbnail || ''),
		attributes: collectAttributes(product),
		downloadUrl: escapeHtml(product.download_url || ''),
	};
};

const appendNormalizedProduct = (collection, product, overrideQty) => {
	if (!product) return;
	const normalized = normalizeProduct(product, overrideQty);
	if (normalized.quantity > 0 || normalized.downloadUrl) {
		collection.push(normalized);
	}
};

const mergeProductQuantities = (products) => {
	const map = new Map();

	const getKey = (product) => {
		const skuPart = product.sku || '';
		const namePart = product.name || '';
		const attributesPart = (product.attributes || []).join('|');
		return `${skuPart}::${namePart}::${attributesPart}`;
	};

	products.forEach((product) => {
		if (!product) return;
		const key = getKey(product);
		const quantity = Math.max(toNumber(product.quantity), 0);

		if (quantity <= 0 && !product.downloadUrl) {
			return;
		}

		if (!map.has(key)) {
			map.set(key, {
				...product,
				quantity,
			});
			return;
		}

		const existing = map.get(key);
		existing.quantity = Math.max(
			toNumber(existing.quantity) + quantity,
			0,
		);
		if (!existing.thumbnail && product.thumbnail) {
			existing.thumbnail = product.thumbnail;
		}
		if (!existing.brand && product.brand) {
			existing.brand = product.brand;
		}
		if (!existing.downloadUrl && product.downloadUrl) {
			existing.downloadUrl = product.downloadUrl;
		}
	});

	return Array.from(map.values()).map((product) => ({
		...product,
		quantity: Math.max(toNumber(product.quantity), 0),
	}));
};

const makeCatalogProduct = (productId, quantity) => {
	const product = catalogProducts[productId];
	if (!product) {
		return null;
	}
	return {
		...product,
		product_id: productId,
		quantity,
	};
};

let readyForPickup = [];
let pickedUp = [];
let shipped = [];
let unshipped = [];
let downloadable = [];

readyForPickupProducts.forEach((product) =>
	appendNormalizedProduct(readyForPickup, product),
);
pickedUpProducts.forEach((product) =>
	appendNormalizedProduct(pickedUp, product),
);
shippedProducts.forEach((product) =>
	appendNormalizedProduct(shipped, product),
);
unshippedProducts.forEach((product) =>
	appendNormalizedProduct(unshipped, product),
);
downloadableProducts.forEach((product) =>
	appendNormalizedProduct(downloadable, product),
);

orderProducts.forEach((product) => {
	const shippedQty = Math.max(toNumber(product.quantity_shipped), 0);
	const orderedQty = Math.max(
		toNumber(product.quantity),
		shippedQty,
	);
	const unshippedQty = Math.max(orderedQty - shippedQty, 0);

	const productType =
		(product.product_type || product.type || '').toLowerCase();
	const isDigital = productType === 'digital' || !!product.download_url;

	if (isDigital) {
		appendNormalizedProduct(downloadable, product, orderedQty);
		return;
	}

	if (shippedQty > 0) {
		appendNormalizedProduct(shipped, product, shippedQty);
	}

	if (unshippedQty > 0) {
		appendNormalizedProduct(unshipped, product, unshippedQty);
	}
});

shipments.forEach((shipment) => {
	(shipment.items || []).forEach((item) => {
		const catalogProduct = makeCatalogProduct(
			item.product_id,
			item.quantity,
		);
		if (catalogProduct) {
			appendNormalizedProduct(
				shipped,
				catalogProduct,
				catalogProduct.quantity,
			);
		}
	});
});

readyForPickup = mergeProductQuantities(readyForPickup);
pickedUp = mergeProductQuantities(pickedUp);
shipped = mergeProductQuantities(shipped);
unshipped = mergeProductQuantities(unshipped);
downloadable = mergeProductQuantities(downloadable);

const trackingEntries = shipments
	.filter(
		(shipment) =>
			shipment.tracking_number ||
			shipment.generated_tracking_link ||
			shipment.tracking_link,
	)
	.map((shipment) => ({
		id: escapeHtml(
			shipment.tracking_number ||
				shipment.generated_tracking_link ||
				shipment.tracking_link ||
				'',
		),
		link: escapeHtml(
			shipment.tracking_link || shipment.generated_tracking_link || '',
		),
		shippingMethod: escapeHtml(
			shipment.shipping_method ||
				shipment.shipping_provider_display_name ||
				shipment.shipping_provider ||
				'',
		),
	}));

const statusRaw =
	(order.custom_status || order.status || order.status_text || '').trim();
const statusLower = statusRaw.toLowerCase();
const statusDisplay = statusRaw || 'updated';

const fulfillmentStatuses = new Set([
	'shipped',
	'awaiting shipment',
	'partially shipped',
	'awaiting pickup',
]);
const trackingStatuses = new Set([
	'shipped',
	'partially shipped',
	'awaiting shipment',
	'completed',
	'awaiting fulfillment',
	'awaiting pickup',
]);

const showFulfillmentSections = fulfillmentStatuses.has(statusLower);
const showTracking = trackingStatuses.has(statusLower);

const epicorId = extractEpicorId(order.external_order_id);

const customerName = escapeHtml(
	order.billing_address?.first_name ||
		order.shipping_address?.first_name ||
		order.customer?.first_name ||
		'there',
);

const orderIdentifier = epicorId || order.id;

const orderTotal = formatCurrency(
	order.total_inc_tax || order.total_ex_tax || order.total,
);
const orderDate = escapeHtml(
	formatDate(order.date_created || order.date_modified),
);
const paymentMethod = escapeHtml(
	order.payment_method || order.payment_status || '',
);
const pickupMethod = escapeHtml(order.pickup_methods || '');

const baseStore = {
	name: storeDetails.name || '',
	domain_name: storeDetails.domain || '',
	path: storeDetails.secure_url || '',
	cdn_path: storeDetails.id
		? `https://cdn11.bigcommerce.com/s-${storeDetails.id}`
		: '',
	logo: {
		title: storeDetails.name || '',
		url: storeDetails.logo?.url || '',
		name: '',
	},
};

const overrideStore = payload.store || {};
const store = {
	...baseStore,
	...overrideStore,
	logo: {
		...(baseStore.logo || {}),
		...(overrideStore.logo || {}),
	},
};

if (!store.path && store.domain_name) {
	store.path = `https://${store.domain_name}`;
}

if (!store.logo.url && store.cdn_path && store.logo.name) {
	store.logo.url = `${store.cdn_path}/images/stencil/300x150/${store.logo.name}`;
}

const storeLink = escapeHtml(store.path || '');
const storeDomain = escapeHtml(store.domain_name || '');
const storeName = escapeHtml(store.name || '');
const storeLogoTitle = escapeHtml(store.logo.title || storeName);
const storeLogoUrl = escapeHtml(store.logo.url || '');

const fallbackCdn = 'https://cdn11.bigcommerce.com/s-7eebdlwfu4';
const cartImage = escapeHtml(
	store.cdn_path
		? `${store.cdn_path}/img/emails/cart.png`
		: `${fallbackCdn}/img/emails/cart.png`,
);
const shopImage = escapeHtml(
	store.cdn_path
		? `${store.cdn_path}/img/emails/shop.png`
		: `${fallbackCdn}/img/emails/shop.png`,
);

const preheaderText = `Order #${order.id}${
	epicorId ? ` (Epicor ID ${epicorId})` : ''
} is now ${statusDisplay}.`;

const emailTitle = 'Order status updated';
const messageLine = `We’ve updated order #${orderIdentifier} to ${statusDisplay}.`;

const renderProductSection = (title, products) => {
	if (!products || !products.length) return '';
	const rows = products
		.map((product) => {
			const imageHtml = product.thumbnail
				? `<th class="products__image-container">
                <img src="${product.thumbnail}" class="products__image" alt="${product.name}">
              </th>`
				: '';

			const skuHtml = product.sku
				? `<p class="products__sku">${product.sku}</p>`
				: '';

			const brandHtml = product.brand
				? `<p class="products__brand">${product.brand}</p>`
				: '';

			const attributesHtml = product.attributes.length
				? `<p class="products__attributes">${product.attributes.join(', ')}</p>`
				: '';

			const downloadHtml = product.downloadUrl
				? `<p class="products__download">
                <a href="${product.downloadUrl}">Download</a>
              </p>`
				: '';

			const quantityLabel =
				product.quantity > 0
					? `<p>Quantity ${product.quantity}</p>`
					: '';

			return `
          <tr class="products__item">
            ${imageHtml}
            <th class="products__content">
              <p><strong>${product.name}</strong></p>
              ${skuHtml}
              ${brandHtml}
              ${attributesHtml}
              ${downloadHtml}
            </th>
            <th class="products__quantity">
              ${quantityLabel}
            </th>
          </tr>`;
		})
		.join('');

	return `
        <table class="spacer spacer--32">
          <tr><td>&nbsp;</td></tr>
        </table>
        <table class="row">
          <tr>
            <th class="column">
              <table>
                <tr>
                  <th>
                    <h2>${escapeHtml(title)}</h2>
                    <table class="products">
                      ${rows}
                    </table>
                  </th>
                  <th class="expander"></th>
                </tr>
              </table>
            </th>
          </tr>
        </table>`;
};

const trackingSection = (() => {
	if (!showTracking) return '';
	if (!trackingEntries.length) {
		return `
        <table class="spacer spacer--32">
          <tr><td>&nbsp;</td></tr>
        </table>
        <table class="row">
          <tr>
            <th class="column">
              <table>
                <tr>
                  <th>
                    <h2>Tracking</h2>
                    <p class="tracking">No tracking numbers yet.</p>
                  </th>
                  <th class="expander"></th>
                </tr>
              </table>
            </th>
          </tr>
        </table>`;
	}

	const items = trackingEntries
		.map((tracking) => {
			const linkHtml = tracking.link
				? `<a href="${tracking.link}" target="_blank">${tracking.id || 'Tracking'}</a>`
				: tracking.id || 'Tracking';
			const method = tracking.shippingMethod
				? ` (${tracking.shippingMethod})`
				: '';
			return `
              <li>
                <p>${linkHtml}${method}</p>
              </li>`;
		})
		.join('');

	return `
        <table class="spacer spacer--32">
          <tr><td>&nbsp;</td></tr>
        </table>
        <table class="row">
          <tr>
            <th class="column">
              <table>
                <tr>
                  <th>
                    <h2>Tracking</h2>
                    <ul class="tracking">
                      ${items}
                    </ul>
                  </th>
                  <th class="expander"></th>
                </tr>
              </table>
            </th>
          </tr>
        </table>`;
})();

const detailsRows = [
	{ label: 'Order total', value: orderTotal },
	{ label: 'Date placed', value: orderDate },
	{ label: 'Payment method', value: paymentMethod },
]
	.concat(pickupMethod ? [{ label: 'Pickup method', value: pickupMethod }] : [])
	.filter((row) => row.value);

const detailsHtml = detailsRows
	.map(
		(row) => `
                              <tr>
                                <th class="details__first-column">
                                  <p>${escapeHtml(row.label)}</p>
                                </th>
                                <th>
                                  <p><strong>${escapeHtml(row.value)}</strong></p>
                                </th>
                              </tr>`,
	)
	.join('');

const fulfillmentSections = showFulfillmentSections
	? [
			renderProductSection('Ready for pickup', readyForPickup),
			renderProductSection('Products to be shipped', unshipped),
			renderProductSection('Picked up', pickedUp),
			renderProductSection('Products shipped', shipped),
	  ]
			.filter(Boolean)
			.join('')
	: '';

const downloadableSection = renderProductSection(
	'Downloadable items',
	downloadable,
);

const logoInner = storeLogoUrl
	? `<img src="${storeLogoUrl}" alt="${storeLogoTitle}">`
	: `<span>${storeLogoTitle}</span>`;
const logoHtml = storeLink
	? `<a href="${storeLink}" target="_blank">${logoInner}</a>`
	: logoInner;

const statusButton = orderLink
	? `
              <table class="spacer spacer--16">
                <tr><td>&nbsp;</td></tr>
              </table>
              <table class="row">
                <tr>
                  <th class="column">
                    <table>
                      <tr>
                        <th>
                          <a href="${escapeHtml(orderLink)}" class="check">Check order status</a>
                        </th>
                        <th class="expander"></th>
                      </tr>
                    </table>
                  </th>
                </tr>
              </table>`
	: '';

const footerLinkUrl = storeLink || (storeDomain ? `https://${storeDomain}` : '');
const footerLink = escapeHtml(footerLinkUrl);

const css = `
    @media only screen {
      html {
        background: #fff;
        min-height: 100%;
      }
    }

    body, table, tr, td, th, div, h1, p, img {
      Margin: 0;
      margin: 0;
      padding: 0;
    }

    body {
      -moz-box-sizing: border-box;
      -webkit-box-sizing: border-box;
      box-sizing: border-box;
      min-width: 100%;
      -ms-text-size-adjust: 100%;
      -webkit-text-size-adjust: 100%;
      width: 100%;
    }

    table {
      border-collapse: collapse;
      border-spacing: 0;
      width: 100%;
    }

    td, th {
      border-collapse: collapse;
    }

    h1, p, a, span, img {
      color: #333;
      font-family: Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol';
      font-size: 14px;
      font-weight: 400;
      -moz-hyphens: auto;
      -webkit-hyphens: auto;
      hyphens: auto;
      line-height: 1.57143;
      word-wrap: break-word;
    }

    h1 {
      font-size: 28px;
      font-weight: 500;
      line-height: 1.21429;
    }

    h1:not(:last-child),
    p:not(:last-child) {
      Margin: 0 0 32px;
      margin: 0 0 32px;
    }

    a {
      color: #2199e8;
      display: inline-block;
      text-decoration: none;
    }

    strong {
      font-weight: 600;
    }

    img {
      border: none;
      display: block;
      outline: 0;
      text-align: center;
      max-width: 100%;
      max-height: 100%;
    }

    hr {
      border: none;
      border-bottom: 1px solid #d0d0d0;
    }

    .preheader {
      display: none;
      font-size: 1px;
      line-height: 1px;
      max-height: 0;
      max-width: 0;
      mso-hide: all;
      opacity: 0;
      overflow: hidden;
      visibility: hidden;
    }

    .body {
      background: #fff;
      height: 100%;
    }

    .body > tr > td {
      text-align: center;
    }

    .container,
    .column {
      Margin: 0 auto;
      margin: 0 auto;
      width: 544px;
    }

    .column td,
    .column th {
      text-align: left;
      vertical-align: top;
    }

    .column--md-9 {
      width: 75%;
    }

    .column--md-3 {
      width: 25%;
    }

    .expander {
      padding: 0 !important;
      visibility: hidden;
      width: 0;
    }

    .spacer--16 td {
      font-size: 16px;
      height: 16px;
      line-height: 16px;
    }

    .spacer--24 td {
      font-size: 24px;
      height: 24px;
      line-height: 24px;
    }

    .spacer--32 td {
      font-size: 32px;
      height: 32px;
      line-height: 32px;
    }

    .spacer--40 td {
      font-size: 40px;
      height: 40px;
      line-height: 40px;
    }

    .delimiter th {
      vertical-align: middle;
    }

    .delimiter__image,
    .delimiter__image-block {
      width: 48px;
    }

    .logo td {
      padding: 24px 0;
    }

    .logo a {
      color: #333;
      display: block;
      text-align: center;
    }

    .logo img {
      color: #333;
      text-decoration: none;
      margin: 0 auto;
    }

    .logo span {
      color: #333;
      font-size: 36px;
      font-weight: 600;
    }

    h2 {
      Margin: 0 0 4px;
      color: #333;
      font-family: Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol';
      font-size: 21px;
      font-weight: 500;
      -moz-hyphens: auto;
      -webkit-hyphens: auto;
      hyphens: auto;
      line-height: 1.57143;
      margin: 0 0 4px;
      word-wrap: break-word;
    }

    .details {
      border-top: 1px solid #e5e5e5;
    }

    .details > tr > th {
      padding-top: 16px;
    }

    .details__content {
      width: auto;
    }

    .details__content tr:not(:last-child) th {
      padding-bottom: 8px;
    }

    .details__content th:first-child {
     	padding-right: 30px;
    }

    .products {
      border-top: 1px solid #e5e5e5;
    }

    .products__item {
      border-bottom: 1px solid #e5e5e5;
    }

    .products__item th {
      padding-bottom: 16px;
      padding-top: 16px;
    }

    .products__image-container,
    .products__content {
      padding-right: 24px;
    }

    .products__image-container {
      height: 80px;
      width: 80px;
    }

    .products__image {
      border: 1px solid #ddd;
      border-radius: 4px;
      height: 78px;
      width: 78px;
    }

    .products__item .products__content,
    .products__item .products__quantity {
      vertical-align: middle;
    }

    .products__content p:not(:last-child) {
      Margin: 0 0 4px;
      margin: 0 0 4px;
    }

    .products__brand,
    .products__attributes,
    .products__sku {
      font-size: 12px;
      line-height: 1.666667;
    }

    .products__quantity {
      width: 65px;
    }

    .tracking {
      border-top: 1px solid #e5e5e5;
      padding-top: 16px;
    }

    .check {
      border: 1px solid #999;
      border-radius: 4px;
      -moz-box-sizing: border-box;
      -webkit-box-sizing: border-box;
      box-sizing: border-box;
      color: #777;
      display: inline-block;
      font-weight: 600;
      padding: 4px 15px;
      text-align: center;
      white-space: nowrap;
    }

    .store p {
      Margin: 0;
      margin: 0;
    }

    .store a {
      color: #777;
      font-size: 12px;
    }

    .store-button a {
      border: 1px solid #999;
      border-radius: 4px;
      -moz-box-sizing: border-box;
      -webkit-box-sizing: border-box;
      box-sizing: border-box;
      color: #777;
      padding: 3px 15px;
      text-align: center;
      white-space: nowrap;
      width: 100%;
    }

    @media only screen and (max-width: 599px) {
      img {
        height: auto !important;
        width: auto !important;
      }

      .container {
        width: 100% !important;
      }

      .column {
        -moz-box-sizing: border-box;
        -webkit-box-sizing: border-box;
        box-sizing: border-box;
        height: auto !important;
        padding-left: 15px !important;
        padding-right: 15px !important;
      }

      .column--xs-12 {
        display: inline-block !important;
        width: 100% !important;
      }

      .delimiter__image {
        width: 48px !important;
      }

      .details__content th {
        width: 100% !important;
        display: block !important;
      }

      .details__first-column {
        padding-bottom: 0 !important;
      }

      .products__image {
        width: 78px !important;
        height: 78px !important;
      }

      .products__content,
      .products__quantity {
        -moz-box-sizing: border-box;
        -webkit-box-sizing: border-box;
        box-sizing: border-box;
        display: inline-block !important;
        width: 100% !important;
      }

      .products__content {
        padding-bottom: 0 !important;
        padding-right: 0 !important;
      }

      .products__quantity {
        padding-top: 12px !important;
      }

      .store th {
        padding-bottom: 16px !important;
      }

      .store p {
        text-align: center !important;
      }

      .store-button a {
        margin-left: auto !important;
        margin-right: auto !important;
      }
    }`;

const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeHtml(locale)}">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width">
  <style type="text/css">
  ${css}
  </style>
</head>
<body>
  <span class="preheader">${escapeHtml(preheaderText)}</span>

  <table class="body">
    <tr>
      <td>
        <table class="spacer spacer--16">
          <tr><td>&nbsp;</td></tr>
        </table>

        <table class="container">
          <tr>
            <td>
              <table class="row">
                <tr>
                  <th class="column">
                    <table class="logo">
                      <tr>
                        <th style="text-align: center;">
                          ${logoHtml}
                        </th>
                        <th class="expander"></th>
                      </tr>
                    </table>
                  </th>
                </tr>
              </table>

              <table class="row">
                <tr>
                  <th class="column">
                    <table>
                      <tr>
                        <th>
                          <table class="delimiter">
                            <tr>
                              <th><hr></th>
                              <th class="delimiter__image-block">
                                <img src="${cartImage}" alt="Cart image" class="delimiter__image">
                              </th>
                              <th><hr></th>
                            </tr>
                          </table>
                        </th>
                        <th class="expander"></th>
                      </tr>
                    </table>
                  </th>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <table class="spacer spacer--40">
          <tr><td>&nbsp;</td></tr>
        </table>

        <table class="container">
          <tr>
            <td>
              <table class="row">
                <tr>
                  <th class="column">
                    <table>
                      <tr>
                        <th>
                          <h1>${escapeHtml(emailTitle)}</h1>
                          <p>
                            Hello ${customerName}<br />
                            ${escapeHtml(messageLine)}
                          </p>
                        </th>
                        <th class="expander"></th>
                      </tr>
                    </table>
                  </th>
                </tr>
              </table>

              <table class="spacer spacer--32">
                <tr><td>&nbsp;</td></tr>
              </table>

              <table class="row">
                <tr>
                  <th class="column">
                    <table>
                      <tr>
                        <th>
                          <h2>Order details</h2>

                          <table class="details">
                            <tr>
                              <th>
                                <table class="details__content">
${detailsHtml}
                                </table>
                              </th>
                            </tr>
                          </table>
                        </th>
                        <th class="expander"></th>
                      </tr>
                    </table>
                  </th>
                </tr>
              </table>

${fulfillmentSections}
${downloadableSection}
${trackingSection}
${statusButton}
            </td>
          </tr>
        </table>

        <table class="spacer spacer--40">
          <tr><td>&nbsp;</td></tr>
        </table>

        <table class="container">
          <tr>
            <td>
              <table class="row">
                <tr>
                  <th class="column">
                    <table>
                      <tr>
                        <th>
                          <table class="delimiter">
                            <tr>
                              <th><hr></th>
                              <th class="delimiter__image-block">
                                <img src="${shopImage}" alt="Shop image" class="delimiter__image">
                              </th>
                              <th><hr></th>
                            </tr>
                          </table>
                        </th>
                        <th class="expander"></th>
                      </tr>
                    </table>
                  </th>
                </tr>
              </table>

              <table class="spacer spacer--24">
                <tr><td>&nbsp;</td></tr>
              </table>

              <table class="row">
                <tr>
                  <th class="column column--md-9 column--xs-12">
                    <table class="store">
                      <tr>
                        <th>
                          <p><strong>${storeName}</strong></p>
                          ${
														footerLink
															? `<p><a href="${footerLink}" target="_blank">${storeDomain || storeLink || footerLink}</a></p>`
															: ''
													}
                        </th>
                        <th class="expander"></th>
                      </tr>
                    </table>
                  </th>

                  <th class="column column--md-3 column--xs-12">
                    ${
											storeLink
												? `<table class="store-button">
                      <tr>
                        <th>
                          <a href="${storeLink}">
                            <strong>Go shopping</strong>
                          </a>
                        </th>
                        <th class="expander"></th>
                      </tr>
                    </table>`
												: ''
										}
                  </th>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <table class="spacer spacer--16">
          <tr><td>&nbsp;</td></tr>
        </table>
      </td>
    </tr>
  </table>

  <div style="display:none;white-space:nowrap;font:15px courier;line-height:0">
    ${'&nbsp;'.repeat(30)}
  </div>
</body>
</html>`;

const subjectIdValue = epicorId ? `${epicorId}` : order.id;
const subject = storeName
	? `Your ${storeName} Order Has Been Updated #${subjectIdValue}`
	: `Order #${subjectIdValue}`;

const recipientEmail =
	payload.recipientEmail ||
	order.billing_address?.email ||
	storeDetails.order_email;

return [
	{
		json: {
			subject,
			to: recipientEmail,
			preheader: escapeHtml(preheaderText),
			html,
			orderId: order.id,
			status: escapeHtml(statusRaw || statusDisplay),
			epicorId,
		},
	},
];
