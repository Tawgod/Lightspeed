const DEFAULT_API_VERSION = '2.0';

export function createLightspeedClient({ domain, token }) {
  if (!domain || !token) {
    throw new Error('Lightspeed configuration is missing.');
  }

  const baseUrl = `https://${domain}.retail.lightspeed.app`;

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'HobbyCorner-LightspeedToolkit/1.0',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const error = new Error(`Lightspeed request failed (${response.status})`);
      error.status = response.status;
      error.details = data;
      throw error;
    }

    return data;
  }

  return {
    getSale(saleId) {
      return request(`/api/${DEFAULT_API_VERSION}/sales/${encodeURIComponent(saleId)}`);
    },

    searchSalesByInvoiceNumber(invoiceNumber) {
      return request(`/api/${DEFAULT_API_VERSION}/search?type=sales&invoice_number=${encodeURIComponent(invoiceNumber)}&page_size=20`);
    },

    getFulfillmentsForSale(saleId) {
      return request(`/api/${DEFAULT_API_VERSION}/fulfillments?sale_id=${encodeURIComponent(saleId)}`);
    },

    getCustomer(customerId) {
      return request(`/api/${DEFAULT_API_VERSION}/customers/${encodeURIComponent(customerId)}`);
    },

    getStoreCredit(customerId) {
      return request(`/api/2026-07/store_credits/${encodeURIComponent(customerId)}`);
    },

    createStoreCreditTransaction(customerId, transaction) {
      return request(`/api/2026-01/store_credits/${encodeURIComponent(customerId)}/transactions`, {
        method: 'POST',
        body: JSON.stringify(transaction)
      });
    },

    createSale(sale) {
      return request('/api/2026-01/sales', {
        method: 'POST',
        body: JSON.stringify(sale)
      });
    },

    updateSale(saleId, sale) {
      return request(`/api/2026-01/sales/${encodeURIComponent(saleId)}`, {
        method: 'PUT',
        body: JSON.stringify(sale)
      });
    }
  };
}
