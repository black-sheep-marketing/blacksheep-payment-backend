const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();

// CORS first (before any routes)
app.use(cors());

// WEBHOOK MUST COME BEFORE express.json()
app.post('/webhook', express.raw({type: 'application/json'}), (req, res) => {
  console.log('🔔 Webhook received!');
  
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!sig) {
    console.log('❌ No webhook signature provided');
    return res.status(400).send('No signature provided');
  }
  
  if (!endpointSecret) {
    console.error('❌ Webhook secret not configured');
    return res.status(500).send('Webhook not configured');
  }
  
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('✅ Webhook signature verified');
    console.log('🎯 Event type:', event.type);
  } catch (err) {
    console.log(`❌ Webhook signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    
    console.log('🎉 Payment succeeded:', paymentIntent.id);
    console.log('📧 Customer email:', paymentIntent.metadata.customer_email);
    console.log('📦 Product:', paymentIntent.metadata.product_id);
    console.log('🔼 Is upsell:', paymentIntent.metadata.is_upsell || 'false');
    console.log('💰 Amount:', paymentIntent.amount);
    
    if (!paymentIntent.metadata?.customer_email) {
      console.log('❌ Payment intent missing customer email');
      return res.status(400).send('Invalid payment intent');
    }
    
    sendConfirmationEmail(paymentIntent).catch(error => {
      console.error('❌ Error in sendConfirmationEmail:', error);
    });
  } else {
    console.log('ℹ️  Webhook event type not handled:', event.type);
  }
  
  res.json({received: true});
});

// NOW JSON middleware (after webhook)
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

// Email validation
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 254;
}

// Amount validation
function isValidAmount(amount) {
  return Number.isInteger(amount) && amount > 0 && amount <= 100000; // Max $1000
}

// Rate limiting
const requestCounts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxRequests = 10;
  
  // Clean old entries
  for (const [key, data] of requestCounts.entries()) {
    if (now - data.firstRequest > windowMs) {
      requestCounts.delete(key);
    }
  }
  
  const current = requestCounts.get(ip) || { count: 0, firstRequest: now };
  
  if (now - current.firstRequest > windowMs) {
    current.count = 1;
    current.firstRequest = now;
  } else {
    current.count++;
  }
  
  requestCounts.set(ip, current);
  
  if (current.count > maxRequests) {
    return res.status(429).json({ error: 'Too many requests, please try again later' });
  }
  
  next();
}

// Check if customer is truly returning (not just upsells)
async function isReturningCustomer(customerId, currentPurchaseTime) {
  try {
    const paymentIntents = await stripe.paymentIntents.list({
      customer: customerId,
      limit: 10,
      created: {
        lt: currentPurchaseTime - 60 // Purchases before current one
      }
    });
    
    const successfulPurchases = paymentIntents.data.filter(pi => 
      pi.status === 'succeeded' && 
      pi.metadata.is_main_purchase === 'true' // Only count main purchases, not upsells
    );
    
    if (successfulPurchases.length === 0) {
      return false; // No previous main purchases
    }
    
    // Check if last main purchase was more than 1 hour ago
    const lastMainPurchase = successfulPurchases[0];
    const hoursSinceLastPurchase = (currentPurchaseTime - lastMainPurchase.created) / 3600;
    
    console.log(`⏰ Hours since last main purchase: ${hoursSinceLastPurchase.toFixed(2)}`);
    
    return hoursSinceLastPurchase >= 1; // 1+ hours = returning customer
    
  } catch (error) {
    console.error('Error checking returning customer status:', error);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// PAYMENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Process main course payment with existing customer detection
app.post('/process-payment', rateLimit, async (req, res) => {
  try {
    const { payment_method_id, email, amount, product_id } = req.body;
    
    // Security validations
    if (!payment_method_id || typeof payment_method_id !== 'string') {
      return res.status(400).json({ error: 'Invalid payment method' });
    }
    
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    
    if (!isValidAmount(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    if (!product_id || typeof product_id !== 'string') {
      return res.status(400).json({ error: 'Invalid product' });
    }
    
    // Whitelist allowed products
    const allowedProducts = {
      'prod_SfYipzYOk3rdyN': 4700, // Main product $47
      'prod_SfYjjur56WyxMI': 29700 // Upsell product $297
    };
    
    if (!allowedProducts[product_id]) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }
    
    if (amount !== allowedProducts[product_id]) {
      return res.status(400).json({ error: 'Amount does not match product' });
    }
    
    const sanitizedEmail = email.toLowerCase().trim();
    let customer;
    let isExistingCustomer = false;
    
    // CHECK FOR EXISTING CUSTOMER FIRST
    try {
      console.log(`🔍 Checking for existing customer: ${sanitizedEmail}`);
      
      const existingCustomers = await stripe.customers.list({
        email: sanitizedEmail,
        limit: 1
      });
      
      if (existingCustomers.data.length > 0) {
        customer = existingCustomers.data[0];
        isExistingCustomer = true;
        console.log(`👤 Found existing customer: ${customer.id}`);
        
        // Attach new payment method to existing customer
        await stripe.paymentMethods.attach(payment_method_id, {
          customer: customer.id,
        });
        
        // Update their default payment method
        await stripe.customers.update(customer.id, {
          invoice_settings: {
            default_payment_method: payment_method_id,
          },
        });
        
      } else {
        console.log(`👤 Creating new customer for: ${sanitizedEmail}`);
        
        customer = await stripe.customers.create({
          email: sanitizedEmail,
          payment_method: payment_method_id,
          invoice_settings: {
            default_payment_method: payment_method_id,
          },
        });
        
        await stripe.paymentMethods.attach(payment_method_id, {
          customer: customer.id,
        });
      }
      
    } catch (customerError) {
      console.error('Error handling customer:', customerError);
      // Fall back to creating new customer
      customer = await stripe.customers.create({
        email: sanitizedEmail,
        payment_method: payment_method_id,
        invoice_settings: {
          default_payment_method: payment_method_id,
        },
      });
      
      await stripe.paymentMethods.attach(payment_method_id, {
        customer: customer.id,
      });
    }
    
    // Create and confirm payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'usd',
      customer: customer.id,
      payment_method: payment_method_id,
      confirmation_method: 'manual',
      confirm: true,
      return_url: 'https://getblacksheep.com/pages/welcome',
      metadata: {
        product_id: product_id,
        customer_email: sanitizedEmail,
        is_main_purchase: 'true',
        is_existing_customer: isExistingCustomer.toString(),
        customer_stripe_id: customer.id,
        purchase_timestamp: Math.floor(Date.now() / 1000).toString()
      }
    });
    
    if (paymentIntent.status === 'requires_action') {
      res.json({
        requires_action: true,
        client_secret: paymentIntent.client_secret,
        customer_id: customer.id,
        payment_method_id: payment_method_id,
        email: sanitizedEmail,
        is_existing_customer: isExistingCustomer
      });
    } else if (paymentIntent.status === 'succeeded') {
      res.json({
        success: true,
        customer_id: customer.id,
        payment_method_id: payment_method_id,
        email: sanitizedEmail,
        is_existing_customer: isExistingCustomer
      });
    } else {
      res.status(400).json({ error: 'Payment failed' });
    }
    
  } catch (error) {
    console.error('Payment processing error:', error);
    
    const safeError = error.type === 'StripeCardError' ? 
      error.message : 'Payment processing failed';
    
    res.status(400).json({ error: safeError });
  }
});

// Process one-click upsell with validation
app.post('/process-upsell', rateLimit, async (req, res) => {
  try {
    const { customer_id, payment_method_id, amount, product_id } = req.body;
    
    // Security validations
    if (!customer_id || !customer_id.startsWith('cus_')) {
      return res.status(400).json({ error: 'Invalid customer ID' });
    }
    
    if (!payment_method_id || !payment_method_id.startsWith('pm_')) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }
    
    if (!isValidAmount(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    // Whitelist upsell products and amounts
    const allowedUpsells = {
      'prod_SfYjjur56WyxMI': 29700 // $297 coaching
    };
    
    if (!allowedUpsells[product_id] || amount !== allowedUpsells[product_id]) {
      return res.status(400).json({ error: 'Invalid upsell product or amount' });
    }
    
    // Verify customer exists
    const customer = await stripe.customers.retrieve(customer_id);
    if (!customer) {
      return res.status(400).json({ error: 'Customer not found' });
    }
    
    // Create and confirm payment intent for upsell
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'usd',
      customer: customer_id,
      payment_method: payment_method_id,
      confirmation_method: 'manual',
      confirm: true,
      metadata: {
        product_id: product_id,
        customer_email: customer.email,
        is_upsell: 'true',
        customer_stripe_id: customer_id,
        purchase_timestamp: Math.floor(Date.now() / 1000).toString()
      }
    });
    
    if (paymentIntent.status === 'succeeded') {
      res.json({ success: true });
    } else if (paymentIntent.status === 'requires_action') {
      res.json({
        requires_action: true,
        client_secret: paymentIntent.client_secret
      });
    } else {
      res.status(400).json({ error: 'Upsell payment failed' });
    }
    
  } catch (error) {
    console.error('Upsell processing error:', error);
    
    const safeError = error.type === 'StripeCardError' ? 
      error.message : 'Upsell processing failed';
    
    res.status(400).json({ error: safeError });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST-PURCHASE PROCESSING
// ═══════════════════════════════════════════════════════════════

// Email confirmation function with all integrations
async function sendConfirmationEmail(paymentIntent) {
  const { customer_email, is_upsell, product_id, customer_stripe_id, purchase_timestamp } = paymentIntent.metadata;
  const amount = paymentIntent.amount / 100;
  
  console.log(`📨 Processing purchase for: ${customer_email}`);
  console.log(`💰 Payment amount: $${amount}`);
  console.log(`📋 Product: ${is_upsell === 'true' ? 'Upsell Purchase' : 'Main Course Purchase'}`);
  
  // Determine purchase type for tracking
  let purchaseType = 'main_course';
  let productName = 'Black Sheep Business Program';
  
  if (is_upsell === 'true') {
    if (product_id === 'prod_SfYjjur56WyxMI') {
      purchaseType = 'coaching_upsell';
      productName = 'Premium 1-on-1 Coaching';
    } else {
      purchaseType = 'second_upsell';
      productName = 'Second Upsell Product';
    }
  }
  
  // Check if this is a returning customer (only for main purchases)
  let isReturning = false;
  if (is_upsell !== 'true' && customer_stripe_id) {
    isReturning = await isReturningCustomer(
      customer_stripe_id, 
      parseInt(purchase_timestamp)
    );
  }
  
  const purchaseData = {
    email: customer_email,
    amount: amount,
    product_id: product_id,
    product_name: productName,
    purchase_type: purchaseType,
    payment_intent_id: paymentIntent.id,
    is_returning_customer: isReturning,
    customer_stripe_id: customer_stripe_id
  };
  
  // Send to all integrations
  await Promise.allSettled([
    sendToKlaviyo(purchaseData),
    subscribeToEmail(purchaseData),
    sendToGoogleSheets({
      ...purchaseData,
      timestamp: new Date().toISOString()
    }),
    createOrUpdateShopifyCustomer(purchaseData),
    createShopifyOrder(purchaseData),
    sendEmailConfirmation(purchaseData)
  ]);
}

// Send data to Klaviyo
async function sendToKlaviyo(data) {
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  
  if (!KLAVIYO_API_KEY) {
    console.log('⚠️ Klaviyo API key not configured');
    return;
  }
  
  try {
    // Add/update profile
    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-07-15'
      },
      body: JSON.stringify({
        data: {
          type: 'profile',
          attributes: {
            email: data.email,
            properties: {
              last_purchase_amount: data.amount,
              last_purchase_product: data.product_name,
              purchase_type: data.purchase_type,
              is_returning_customer: data.is_returning_customer
            }
          }
        }
      })
    });
    
    // Track purchase event
    const eventResponse = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-07-15'
      },
      body: JSON.stringify({
        data: {
          type: 'event',
          attributes: {
            profile: { email: data.email },
            metric: { name: 'Purchase Completed' },
            properties: {
              purchase_type: data.purchase_type,
              product_name: data.product_name,
              product_id: data.product_id,
              amount: data.amount,
              payment_intent_id: data.payment_intent_id,
              is_returning_customer: data.is_returning_customer
            }
          }
        }
      })
    });
    
    console.log('✅ Data sent to Klaviyo successfully');
    
  } catch (error) {
    console.error('❌ Failed to send data to Klaviyo:', error.message);
  }
}

// Subscribe customer to email lists
async function subscribeToEmail(data) {
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID; // Main email list
  
  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
    console.log('⚠️ Klaviyo email subscription not configured');
    return;
  }
  
  try {
    // Subscribe to main email list
    const subscribeResponse = await fetch(`https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/`, {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-07-15'
      },
      body: JSON.stringify({
        data: {
          type: 'profile-subscription-bulk-create-job',
          attributes: {
            profiles: {
              data: [{
                type: 'profile',
                attributes: {
                  email: data.email,
                  subscriptions: {
                    email: {
                      marketing: {
                        consent: 'SUBSCRIBED'
                      }
                    }
                  }
                }
              }]
            }
          },
          relationships: {
            list: {
              data: {
                type: 'list',
                id: KLAVIYO_LIST_ID
              }
            }
          }
        }
      })
    });
    
    if (subscribeResponse.ok) {
      console.log(`📧 Subscribed ${data.email} to email list`);
    }
    
    // Add to specific lists based on purchase type
    const purchaseSpecificLists = {
      'main_course': process.env.KLAVIYO_MAIN_COURSE_LIST_ID,
      'coaching_upsell': process.env.KLAVIYO_COACHING_LIST_ID,
      'second_upsell': process.env.KLAVIYO_PREMIUM_LIST_ID
    };
    
    const specificListId = purchaseSpecificLists[data.purchase_type];
    if (specificListId) {
      // Subscribe to product-specific list
      await fetch(`https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/`, {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2024-07-15'
        },
        body: JSON.stringify({
          data: {
            type: 'profile-subscription-bulk-create-job',
            attributes: {
              profiles: {
                data: [{
                  type: 'profile',
                  attributes: {
                    email: data.email,
                    subscriptions: {
                      email: {
                        marketing: {
                          consent: 'SUBSCRIBED'
                        }
                      }
                    }
                  }
                }]
              }
            },
            relationships: {
              list: {
                data: {
                  type: 'list',
                  id: specificListId
                }
              }
            }
          }
        })
      });
      
      console.log(`📧 Subscribed ${data.email} to ${data.purchase_type} list`);
    }
    
  } catch (error) {
    console.error('❌ Failed to subscribe to email:', error.message);
  }
}

// Send data to Google Sheets
async function sendToGoogleSheets(data) {
  const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  
  if (!GOOGLE_SHEETS_URL) {
    console.log('⚠️ Google Sheets webhook URL not configured');
    return;
  }
  
  try {
    const response = await fetch(GOOGLE_SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: data.email,
        amount: data.amount,
        product_id: data.product_id,
        product_name: data.product_name,
        purchase_type: data.purchase_type,
        payment_intent_id: data.payment_intent_id,
        is_returning_customer: data.is_returning_customer,
        timestamp: data.timestamp
      })
    });
    
    if (response.ok) {
      console.log('✅ Data sent to Google Sheets successfully');
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
    
  } catch (error) {
    console.error('❌ Failed to send data to Google Sheets:', error.message);
  }
}

// Enhanced Shopify integration with returning customer logic
async function createOrUpdateShopifyCustomer(data) {
  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    console.log('⚠️ Shopify credentials not configured');
    return;
  }
  
  console.log(`🛍️ Processing Shopify customer: ${data.email}`);
  console.log(`📦 Purchase type: ${data.purchase_type}`);
  console.log(`🔄 Is returning customer: ${data.is_returning_customer}`);
  
  try {
    // Get tags for this purchase type
    const newTags = getTagsForPurchase(data.purchase_type);
    console.log(`🏷️ Tags to apply: ${newTags.join(', ')}`);
    
    // Search for existing customer
    const searchUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(data.email)}`;
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    const searchResult = await searchResponse.json();
    
    if (searchResult.customers && searchResult.customers.length > 0) {
      // EXISTING CUSTOMER - Update
      const customer = searchResult.customers[0];
      console.log(`👤 Updating existing Shopify customer: ${customer.id}`);
      
      const existingTags = customer.tags ? customer.tags.split(', ').map(tag => tag.trim()) : [];
      const allTags = [...new Set([...existingTags, ...newTags])];
      
      // Add returning customer tag only if truly returning (time-based)
      if (data.is_returning_customer && !allTags.includes('returning-customer')) {
        allTags.push('returning-customer');
        console.log(`✨ Added returning-customer tag`);
      }
      
      const updateResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers/${customer.id}.json`, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customer: {
            id: customer.id,
            tags: allTags.join(', '),
            note: updateCustomerNote(customer.note, data),
            accepts_marketing: true // Subscribe to marketing
          }
        })
      });
      
      if (updateResponse.ok) {
        console.log(`✅ Updated customer with tags: ${allTags.join(', ')}`);
        return customer.id; // Return customer ID for order creation
      }
      
    } else {
      // NEW CUSTOMER - Create
      console.log(`👤 Creating new Shopify customer...`);
      
      const createResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customer: {
            email: data.email,
            tags: [...newTags, 'first-time-customer'].join(', '),
            note: buildCustomerNote(data),
            verified_email: true,
            accepts_marketing: true
          }
        })
      });
      
      if (createResponse.ok) {
        const newCustomer = await createResponse.json();
        console.log(`✅ Created new customer with tags: ${newTags.join(', ')}, first-time-customer`);
        return newCustomer.customer.id; // Return customer ID for order creation
      }
    }
    
  } catch (error) {
    console.error('❌ Shopify customer error:', error.message);
    return null;
  }
}

// Create Shopify order for revenue tracking
async function createShopifyOrder(data) {
  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    console.log('⚠️ Shopify credentials not configured for orders');
    return;
  }
  
  console.log(`🛒 Creating Shopify order for: ${data.email}`);
  console.log(`💰 Order amount: ${data.amount}`);
  
  try {
    // Get Shopify customer ID
    const searchUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(data.email)}`;
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    const searchResult = await searchResponse.json();
    let shopifyCustomerId = null;
    
    if (searchResult.customers && searchResult.customers.length > 0) {
      shopifyCustomerId = searchResult.customers[0].id;
    }
    
    // Define product details for order line items
    const productDetails = {
      'prod_SfYipzYOk3rdyN': {
        title: 'Black Sheep Business Program',
        price: '47.00',
        sku: 'BSBP-MAIN-001',
        vendor: 'Black Sheep Business'
      },
      'prod_SfYjjur56WyxMI': {
        title: 'Premium 1-on-1 Coaching',
        price: '297.00', 
        sku: 'BSBP-COACH-001',
        vendor: 'Black Sheep Business'
      }
    };
    
    const product = productDetails[data.product_id] || {
      title: data.product_name,
      price: data.amount.toString(),
      sku: `BSBP-${data.product_id}`,
      vendor: 'Black Sheep Business'
    };
    
    // Create order payload
    const orderData = {
      order: {
        email: data.email,
        financial_status: 'paid',
        fulfillment_status: null,
        send_receipt: false,
        send_fulfillment_receipt: false,
        note: `Order created from Stripe payment: ${data.payment_intent_id}`,
        tags: `stripe-payment, ${data.purchase_type}, payment-intent-${data.payment_intent_id}`,
        line_items: [
          {
            title: product.title,
            price: product.price,
            quantity: 1,
            vendor: product.vendor,
            product_id: null, // We're not using Shopify products, just line items
            variant_id: null,
            sku: product.sku,
            requires_shipping: false,
            taxable: false,
            gift_card: false,
            fulfillment_service: 'manual',
            properties: [
              {
                name: 'Purchase Type',
                value: data.purchase_type
              },
              {
                name: 'Stripe Payment ID',
                value: data.payment_intent_id
              },
              {
                name: 'Product ID',
                value: data.product_id
              }
            ]
          }
        ],
        transactions: [
          {
            kind: 'sale',
            status: 'success',
            amount: data.amount.toString(),
            currency: 'USD',
            gateway: 'Stripe',
            source_name: 'web',
            receipt: {
              payment_id: data.payment_intent_id
            }
          }
        ],
        total_price: data.amount.toString(),
        subtotal_price: data.amount.toString(),
        total_tax: '0.00',
        currency: 'USD',
        created_at: new Date().toISOString(),
        source_name: 'web',
        referring_site: 'getblacksheep.com',
        landing_site: 'getblacksheep.com'
      }
    };
    
    // Add customer ID if found
    if (shopifyCustomerId) {
      orderData.order.customer = {
        id: shopifyCustomerId
      };
    } else {
      // Create customer data inline if not found
      orderData.order.customer = {
        email: data.email,
        accepts_marketing: true,
        first_name: '',
        last_name: ''
      };
    }
    
    // Add billing address (required for orders)
    orderData.order.billing_address = {
      first_name: '',
      last_name: '',
      address1: '',
      city: '',
      province: '',
      country: 'US',
      zip: '',
      phone: '',
      email: data.email
    };
    
    // Create the order
    const createResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/orders.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderData)
    });
    
    if (createResponse.ok) {
      const newOrder = await createResponse.json();
      console.log(`✅ Created Shopify order: #${newOrder.order.order_number || newOrder.order.id}`);
      console.log(`💰 Order total: ${newOrder.order.total_price}`);
      console.log(`📊 Revenue tracking enabled in Shopify dashboard`);
      
      return newOrder.order.id;
    } else {
      const errorData = await createResponse.text();
      console.error(`❌ Failed to create Shopify order: ${createResponse.status}`);
      console.error('Error details:', errorData);
      throw new Error(`Shopify order creation failed: ${createResponse.status}`);
    }
    
  } catch (error) {
    console.error('❌ Shopify order creation error:', error.message);
    // Don't throw error - continue processing even if order creation fails
  }
}

// Build initial customer note
function buildCustomerNote(data) {
  const timestamp = new Date().toLocaleDateString();
  return `Purchase History:
- ${data.product_name}: $${data.amount} (${timestamp})

Purchase Details:
- Type: ${data.purchase_type}
- Payment ID: ${data.payment_intent_id}
- Product ID: ${data.product_id}
- Returning Customer: ${data.is_returning_customer ? 'Yes' : 'No'}`;
}

// Update existing customer note
function updateCustomerNote(existingNote, data) {
  const timestamp = new Date().toLocaleDateString();
  const newPurchase = `- ${data.product_name}: $${data.amount} (${timestamp})`;
  
  if (!existingNote) {
    return buildCustomerNote(data);
  }
  
  if (existingNote.includes('Purchase History:')) {
    const lines = existingNote.split('\n');
    const purchaseIndex = lines.findIndex(line => line.includes('Purchase History:'));
    
    if (purchaseIndex !== -1) {
      lines.splice(purchaseIndex + 1, 0, newPurchase);
      return lines.join('\n');
    }
  }
  
  return existingNote + '\n\nPurchase History:\n' + newPurchase;
}

// Calculate tags for purchase type
function getTagsForPurchase(purchaseType) {
  const baseTag = 'customer';
  
  switch(purchaseType) {
    case 'main_course':
      return [baseTag, 'step-2'];
    case 'coaching_upsell':
      return [baseTag, 'step-2', 'step-3'];
    case 'second_upsell':
      return [baseTag, 'step-2', 'step-3', 'step-4'];
    case 'third_upsell':
      return [baseTag, 'step-2', 'step-3', 'step-4', 'step-5'];
    case 'fourth_upsell':
      return [baseTag, 'step-2', 'step-3', 'step-4', 'step-5', 'step-6'];
    default:
      console.log(`⚠️ Unknown purchase type: ${purchaseType}`);
      return [baseTag];
  }
}

// Send confirmation email
async function sendEmailConfirmation(data) {
  console.log(`📧 Would send ${data.purchase_type} confirmation email to: ${data.email}`);
  console.log(`📦 Product: ${data.product_name} - $${data.amount}`);
  console.log(`🔄 Returning customer: ${data.is_returning_customer}`);
}

// ═══════════════════════════════════════════════════════════════
// TEST AND DEBUG ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Test Shopify integration
app.post('/test-shopify', async (req, res) => {
  const { email, purchase_type } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required for testing' });
  }
  
  try {
    const testData = {
      email: email,
      amount: purchase_type === 'main_course' ? 47 : 297,
      product_id: purchase_type === 'main_course' ? 'prod_SfYipzYOk3rdyN' : 'prod_SfYjjur56WyxMI',
      product_name: purchase_type === 'main_course' ? 'Black Sheep Business Program' : 'Premium 1-on-1 Coaching',
      purchase_type: purchase_type || 'main_course',
      payment_intent_id: 'test_' + Date.now(),
      is_returning_customer: false
    };
    
    console.log('🧪 Testing Shopify integration with data:', testData);
    
    // Test both customer and order creation
    await createOrUpdateShopifyCustomer(testData);
    await createShopifyOrder(testData);
    
    res.json({ 
      success: true, 
      message: `Successfully processed ${purchase_type} for ${email}`,
      tags_applied: getTagsForPurchase(purchase_type),
      order_created: true
    });
    
  } catch (error) {
    console.error('❌ Shopify test failed:', error);
    res.status(500).json({ 
      error: error.message,
      details: 'Check server logs for full error details'
    });
  }
});

// Test order creation specifically
app.post('/test-shopify-order', async (req, res) => {
  const { email, purchase_type } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required for testing' });
  }
  
  try {
    const testData = {
      email: email,
      amount: purchase_type === 'main_course' ? 47 : 297,
      product_id: purchase_type === 'main_course' ? 'prod_SfYipzYOk3rdyN' : 'prod_SfYjjur56WyxMI',
      product_name: purchase_type === 'main_course' ? 'Black Sheep Business Program' : 'Premium 1-on-1 Coaching',
      purchase_type: purchase_type || 'main_course',
      payment_intent_id: 'order_test_' + Date.now(),
      is_returning_customer: false
    };
    
    console.log('🛒 Testing Shopify order creation with data:', testData);
    
    const orderId = await createShopifyOrder(testData);
    
    res.json({ 
      success: true, 
      message: `Successfully created order for ${email}`,
      order_id: orderId,
      amount: testData.amount,
      product: testData.product_name
    });
    
  } catch (error) {
    console.error('❌ Shopify order test failed:', error);
    res.status(500).json({ 
      error: error.message,
      details: 'Check server logs for full error details'
    });
  }
});

// Check customer in Shopify
app.get('/test-shopify-customer/:email', async (req, res) => {
  const { email } = req.params;
  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Shopify credentials not configured' });
  }
  
  try {
    const searchResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    const searchResult = await searchResponse.json();
    
    if (searchResult.customers && searchResult.customers.length > 0) {
      const customer = searchResult.customers[0];
      res.json({
        found: true,
        customer: {
          id: customer.id,
          email: customer.email,
          tags: customer.tags,
          note: customer.note,
          accepts_marketing: customer.accepts_marketing,
          created_at: customer.created_at,
          updated_at: customer.updated_at
        }
      });
    } else {
      res.json({
        found: false,
        message: 'Customer not found in Shopify'
      });
    }
    
  } catch (error) {
    console.error('❌ Failed to search Shopify customer:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get customer purchase history
app.get('/customer-history/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase().trim();
    
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });
    
    if (customers.data.length === 0) {
      return res.json({ 
        found: false, 
        message: 'Customer not found' 
      });
    }
    
    const customer = customers.data[0];
    
    const paymentIntents = await stripe.paymentIntents.list({
      customer: customer.id,
      limit: 10
    });
    
    const purchaseHistory = paymentIntents.data
      .filter(pi => pi.status === 'succeeded')
      .map(pi => ({
        amount: pi.amount / 100,
        date: new Date(pi.created * 1000).toLocaleDateString(),
        product_id: pi.metadata.product_id,
        is_upsell: pi.metadata.is_upsell === 'true',
        is_main_purchase: pi.metadata.is_main_purchase === 'true',
        payment_intent_id: pi.id
      }));
    
    const totalSpent = purchaseHistory.reduce((sum, purchase) => sum + purchase.amount, 0);
    
    res.json({
      found: true,
      customer_id: customer.id,
      email: customer.email,
      total_spent: totalSpent,
      purchase_count: purchaseHistory.length,
      purchase_history: purchaseHistory,
      created: new Date(customer.created * 1000).toLocaleDateString()
    });
    
  } catch (error) {
    console.error('Error fetching customer history:', error);
    res.status(500).json({ error: 'Failed to fetch customer history' });
  }
});

// Debug environment variables
app.get('/debug-env', (req, res) => {
  res.json({
    stripe_key_configured: !!process.env.STRIPE_SECRET_KEY,
    shopify_url_configured: !!process.env.SHOPIFY_STORE_URL,
    shopify_token_configured: !!process.env.SHOPIFY_ACCESS_TOKEN,
    klaviyo_configured: !!process.env.KLAVIYO_API_KEY,
    klaviyo_list_configured: !!process.env.KLAVIYO_LIST_ID,
    google_sheets_configured: !!process.env.GOOGLE_SHEETS_WEBHOOK_URL,
    webhook_secret_configured: !!process.env.STRIPE_WEBHOOK_SECRET,
    node_env: process.env.NODE_ENV || 'development',
    environment_vars_count: Object.keys(process.env).length
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Black Sheep Payment Server Running! 🐑',
    message: 'Ready to process seamless payments and upsells',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// Test Stripe connection
app.get('/test-stripe', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ 
      status: 'Stripe connected successfully! ✅',
      currency: balance.available[0]?.currency || 'usd',
      mode: process.env.STRIPE_SECRET_KEY?.includes('test') ? 'test' : 'live'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'Stripe connection failed ❌',
      error: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Black Sheep payment server running on port ${PORT}`);
  console.log(`💳 Ready to process $47 main sales and $297 upsells!`);
  console.log(`🌐 Health check: http://localhost:${PORT}/`);
  console.log(`🛡️ Environment: ${process.env.NODE_ENV || 'development'}`);
});
