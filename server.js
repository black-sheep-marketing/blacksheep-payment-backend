const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

// FIX: Add the missing requestCounts Map - this was causing the 500 error!
const requestCounts = new Map();

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

// Dynamic product validation against Stripe catalog
async function validateProduct(productId, amount) {
  try {
    // Check if we're in test mode
    const isTestMode = process.env.STRIPE_SECRET_KEY?.includes('test');
    
    if (isTestMode) {
      console.log('🧪 Test mode detected - using flexible product validation');
      
      // In test mode, allow common test scenarios without strict validation
      const testProducts = {
        'prod_SfYipzYOk3rdyN': { name: 'Black Sheep Business Program', amount: 4700 },
        'prod_SfYjjur56WyxMI': { name: 'Premium 1-on-1 Coaching', amount: 29700 },
        'prod_SfdrwTwTQpDt5a': { name: 'Software', amount: 9700 }
      };
      
      // If it's a known test product, return mock validation
      if (testProducts[productId]) {
        const testProduct = testProducts[productId];
        if (testProduct.amount === amount) {
          return {
            isValid: true,
            product: { 
              id: productId, 
              name: testProduct.name, 
              active: true 
            },
            price: { 
              id: 'price_test', 
              unit_amount: amount, 
              currency: 'usd' 
            }
          };
        }
      }
      
      // For other test cases, try to fetch from Stripe but don't fail if not found
      try {
        const product = await stripe.products.retrieve(productId);
        
        if (!product.active) {
          throw new Error('Product is not active');
        }
        
        const prices = await stripe.prices.list({
          product: productId,
          active: true,
          limit: 10
        });
        
        if (prices.data.length === 0) {
          throw new Error('No active prices found for product');
        }
        
        const validPrice = prices.data.find(price => 
          price.unit_amount === amount && price.currency === 'usd'
        );
        
        if (!validPrice) {
          throw new Error(`Amount ${amount} cents does not match any valid price for this product`);
        }
        
        return {
          isValid: true,
          product: product,
          price: validPrice
        };
        
      } catch (testError) {
        // In test mode, if product doesn't exist, create a mock response
        console.log(`⚠️ Test mode: Product ${productId} not found, using fallback validation`);
        return {
          isValid: true,
          product: { 
            id: productId, 
            name: 'Test Product', 
            active: true 
          },
          price: { 
            id: 'price_test_fallback', 
            unit_amount: amount, 
            currency: 'usd' 
          }
        };
      }
    }
    
    // LIVE MODE - Strict validation
    console.log('🔴 Live mode detected - using strict product validation');
    
    // Get product details from Stripe
    const product = await stripe.products.retrieve(productId);
    
    if (!product.active) {
      throw new Error('Product is not active');
    }
    
    // Get the default price for this product
    const prices = await stripe.prices.list({
      product: productId,
      active: true,
      limit: 10
    });
    
    if (prices.data.length === 0) {
      throw new Error('No active prices found for product');
    }
    
    // Check if the submitted amount matches any of the product's prices
    const validPrice = prices.data.find(price => 
      price.unit_amount === amount && price.currency === 'usd'
    );
    
    if (!validPrice) {
      throw new Error(`Amount ${amount} cents does not match any valid price for this product`);
    }
    
    return {
      isValid: true,
      product: product,
      price: validPrice
    };
    
  } catch (error) {
    console.error('Product validation error:', error.message);
    return {
      isValid: false,
      error: error.message
    };
  }
}

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
    
    // DEBUG: Log the received amount
    console.log(`🔍 DEBUG: Received amount from frontend: ${amount} (should be in cents)`);
    console.log(`🔍 DEBUG: Amount as dollars: ${amount / 100}`);
    console.log(`🔍 DEBUG: Product ID: ${product_id}`);
    
    // Security validations
    if (!payment_method_id || typeof payment_method_id !== 'string') {
      return res.status(400).json({ error: 'Invalid payment method' });
    }
    
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    
    if (!isValidAmount(amount)) {
      console.log(`❌ Amount validation failed: ${amount}`);
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    if (!product_id || typeof product_id !== 'string') {
      return res.status(400).json({ error: 'Invalid product' });
    }
    
    // Dynamic product validation against Stripe
    const productValidation = await validateProduct(product_id, amount);
    if (!productValidation.isValid) {
      return res.status(400).json({ error: productValidation.error });
    }
    
    console.log(`✅ Product validated: ${productValidation.product.name} - ${amount/100} (${amount} cents)`);
    
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
    
    // DEBUG: Log amount before creating payment intent
    console.log(`💳 Creating payment intent with amount: ${amount} cents (${amount/100})`);
    
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
    
    console.log(`🎉 Payment intent created: ${paymentIntent.id} for ${paymentIntent.amount/100}`);
    
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

// Process opt-in form submission (no payment)
app.post('/process-optin', rateLimit, async (req, res) => {
  try {
    const { name, email, phone, optin_tag, form_name, lead_magnet, step_number } = req.body;
    
    // Validation
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Invalid name - please enter your full name' });
    }
    
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    if (!optin_tag || typeof optin_tag !== 'string') {
      return res.status(400).json({ error: 'Invalid optin configuration' });
    }
    
    const sanitizedEmail = email.toLowerCase().trim();
    const sanitizedName = name.trim();
    const sanitizedPhone = phone.trim();
    
    console.log(`📋 Processing opt-in for: ${sanitizedEmail}`);
    console.log(`📝 Form: ${form_name || 'Unknown'}`);
    console.log(`🏷️ Tag: ${optin_tag}`);
    
    // Create opt-in data for processing
    const optinData = {
      email: sanitizedEmail,
      name: sanitizedName,
      phone: sanitizedPhone,
      optin_tag: optin_tag,
      form_name: form_name || 'Opt-in Form',
      lead_magnet: lead_magnet || 'Lead Magnet',
      step_number: step_number || 1,
      optin_timestamp: new Date().toISOString()
    };
    
    // Process the opt-in - SIMPLIFIED to just Shopify (will auto-sync to Klaviyo)
    await createOrUpdateShopifyLead(optinData);
    
    console.log(`✅ Opt-in processed successfully for: ${sanitizedEmail}`);
    
    res.json({
      success: true,
      message: 'Opt-in processed successfully',
      email: sanitizedEmail,
      optin_tag: optin_tag
    });
    
  } catch (error) {
    console.error('Opt-in processing error:', error);
    res.status(400).json({ error: 'Failed to process opt-in. Please try again.' });
  }
});

// Create or update Shopify customer with opt-in tag
async function createOrUpdateShopifyLead(data) {
  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    console.log('⚠️ Shopify credentials not configured for opt-ins');
    return;
  }
  
  console.log(`🛍️ Processing Shopify lead: ${data.email}`);
  console.log(`🏷️ Opt-in tag: ${data.optin_tag}`);
  
  try {
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
      // EXISTING CUSTOMER - Add opt-in tag
      const customer = searchResult.customers[0];
      console.log(`👤 Updating existing Shopify customer: ${customer.id}`);
      
      const existingTags = customer.tags ? customer.tags.split(', ').map(tag => tag.trim()) : [];
      const newTags = ['lead', data.optin_tag];
      const allTags = [...new Set([...existingTags, ...newTags])];
      
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
            phone: data.phone,
            first_name: data.name.split(' ')[0],
            last_name: data.name.split(' ').slice(1).join(' '),
            note: updateOptinNote(customer.note, data),
            accepts_marketing: true,
            accepts_marketing_updated_at: new Date().toISOString(),
            email_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString(),
              consent_collected_from: 'WEB'
            },
            sms_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString(),
              consent_collected_from: 'WEB'
            }
          }
        })
      });
      
      if (updateResponse.ok) {
        console.log(`✅ Updated lead with tags: ${allTags.join(', ')}`);
        console.log(`📧 Email marketing: SUBSCRIBED`);
        console.log(`📱 SMS marketing: SUBSCRIBED`);
      }
      
    } else {
      // NEW LEAD - Create customer
      console.log(`👤 Creating new Shopify lead...`);
      
      const createResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customer: {
            email: data.email,
            phone: data.phone,
            first_name: data.name.split(' ')[0],
            last_name: data.name.split(' ').slice(1).join(' '),
            tags: ['lead', data.optin_tag].join(', '),
            note: buildOptinNote(data),
            verified_email: false,
            accepts_marketing: true,
            accepts_marketing_updated_at: new Date().toISOString(),
            email_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString(),
              consent_collected_from: 'WEB'
            },
            sms_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString(),
              consent_collected_from: 'WEB'
            }
          }
        })
      });
      
      if (createResponse.ok) {
        const newCustomer = await createResponse.json();
        console.log(`✅ Created new lead with tags: lead, ${data.optin_tag}`);
        console.log(`📧 Email marketing: SUBSCRIBED`);
        console.log(`📱 SMS marketing: SUBSCRIBED`);
      }
    }
    
  } catch (error) {
    console.error('❌ Shopify lead error:', error.message);
  }
}

// Build opt-in note
function buildOptinNote(data) {
  return `Lead Information:
- Form: ${data.form_name}
- Lead Magnet: ${data.lead_magnet}
- Opted In: ${new Date(data.optin_timestamp).toLocaleDateString()}
- Step: ${data.step_number}
- Tag: ${data.optin_tag}`;
}

// Update existing customer note with opt-in info
function updateOptinNote(existingNote, data) {
  const optinInfo = `
Lead Activity:
- Form: ${data.form_name} (${new Date(data.optin_timestamp).toLocaleDateString()})
- Lead Magnet: ${data.lead_magnet}
- Tag: ${data.optin_tag}`;
  
  if (!existingNote) {
    return buildOptinNote(data);
  }
  
  if (existingNote.includes('Lead Activity:')) {
    return existingNote + '\n' + optinInfo;
  } else {
    return existingNote + '\n' + optinInfo;
  }
}

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
    
    // Dynamic product validation against Stripe
    const productValidation = await validateProduct(product_id, amount);
    if (!productValidation.isValid) {
      return res.status(400).json({ error: productValidation.error });
    }
    
    console.log(`✅ Upsell product validated: ${productValidation.product.name} - ${amount/100}`);
    
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

// Email confirmation function - SIMPLIFIED to just Shopify
async function sendConfirmationEmail(paymentIntent) {
  const { customer_email, is_upsell, product_id, customer_stripe_id, purchase_timestamp, product_tag } = paymentIntent.metadata;
  const amount = paymentIntent.amount / 100;
  
  console.log(`📨 Processing purchase for: ${customer_email}`);
  console.log(`💰 Payment amount: ${amount}`);
  console.log(`📋 Product: ${is_upsell === 'true' ? 'Upsell Purchase' : 'Main Course Purchase'}`);
  console.log(`🏷️ Product tag: ${product_tag || 'main-course'}`);
  
  // Determine purchase type dynamically based on product name and metadata
  let purchaseType = 'main_course';
  let productName = 'Unknown Product';
  
  if (is_upsell === 'true') {
    // Try to get product name from Stripe
    try {
      const product = await stripe.products.retrieve(product_id);
      productName = product.name;
      
      // Use the specific product tag if provided, otherwise fallback to name analysis
      if (product_tag) {
        purchaseType = product_tag.replace('-', '_'); // Convert coaching-buyer to coaching_buyer
      } else {
        // Fallback to name analysis for legacy support
        const nameUpper = product.name.toUpperCase();
        if (nameUpper.includes('COACHING') || nameUpper.includes('COACH')) {
          purchaseType = 'coaching_upsell';
        } else if (nameUpper.includes('SOFTWARE') || nameUpper.includes('SOFT')) {
          purchaseType = 'software_upsell';
        } else if (nameUpper.includes('PREMIUM') || nameUpper.includes('ADVANCED')) {
          purchaseType = 'premium_upsell';
        } else {
          purchaseType = 'generic_upsell';
        }
      }
    } catch (error) {
      console.error('Could not retrieve product details:', error.message);
      purchaseType = product_tag ? product_tag.replace('-', '_') : 'generic_upsell';
      productName = 'Upsell Product';
    }
  } else {
    // Main course - try to get actual product name
    try {
      const product = await stripe.products.retrieve(product_id);
      productName = product.name;
    } catch (error) {
      console.error('Could not retrieve main product details:', error.message);
      productName = 'Main Product';
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
    customer_stripe_id: customer_stripe_id,
    product_tag: product_tag || 'main-course' // Pass the specific tag
  };
  
  // SIMPLIFIED - Only send to Shopify (will auto-sync to Klaviyo)
  await Promise.allSettled([
    createOrUpdateShopifyCustomer(purchaseData),
    createShopifyOrder(purchaseData),
    sendEmailConfirmation(purchaseData)
  ]);
}

// Enhanced Shopify integration with specific product tags
async function createOrUpdateShopifyCustomer(data) {
  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    console.log('⚠️ Shopify credentials not configured');
    return;
  }
  
  console.log(`🛍️ Processing Shopify customer: ${data.email}`);
  console.log(`📦 Product tag: ${data.product_tag}`);
  console.log(`🔄 Is returning customer: ${data.is_returning_customer}`);
  
  try {
    // Use specific product tag instead of progressive tagging
    const baseTag = 'customer';
    const productSpecificTag = data.product_tag || 'unknown-product';
    const newTags = [baseTag, productSpecificTag];
    
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
      // EXISTING CUSTOMER - Add new product tag
      const customer = searchResult.customers[0];
      console.log(`👤 Updating existing Shopify customer: ${customer.id}`);
      
      const existingTags = customer.tags ? customer.tags.split(', ').map(tag => tag.trim()) : [];
      
      // Add new product-specific tag (avoid duplicates)
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
            accepts_marketing: true,
            accepts_marketing_updated_at: new Date().toISOString(),
            email_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString(),
              consent_collected_from: 'WEB'
            },
            sms_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString(),
              consent_collected_from: 'WEB'
            }
          }
        })
      });
      
      if (updateResponse.ok) {
        console.log(`✅ Updated customer with tags: ${allTags.join(', ')}`);
        console.log(`📧 Email marketing: SUBSCRIBED`);
        console.log(`📱 SMS marketing: SUBSCRIBED`);
        return customer.id;
      }
      
    } else {
      // NEW CUSTOMER - Create with specific tags
      console.log(`👤 Creating new Shopify customer...`);
      
      const initialTags = [...newTags, 'first-time-customer'];
      
      const createResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customer: {
            email: data.email,
            tags: initialTags.join(', '),
            note: buildCustomerNote(data),
            verified_email: true,
            accepts_marketing: true,
            accepts_marketing_updated_at: new Date().toISOString(),
            email_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString(),
              consent_collected_from: 'WEB'
            },
            sms_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString(),
              consent_collected_from: 'WEB'
            }
          }
        })
      });
      
      if (createResponse.ok) {
        const newCustomer = await createResponse.json();
        console.log(`✅ Created new customer with tags: ${initialTags.join(', ')}`);
        console.log(`📧 Email marketing: SUBSCRIBED`);
        console.log(`📱 SMS marketing: SUBSCRIBED`);
        return newCustomer.customer.id;
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
  console.log(`💰 Order amount: ${data.amount} dollars`);
  console.log(`💰 Order amount in cents: ${data.amount * 100}`);
  
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
    
    // Get product details dynamically from Stripe
    let product;
    try {
      const stripeProduct = await stripe.products.retrieve(data.product_id);
      product = {
        title: stripeProduct.name,
        price: data.amount.toFixed(2),  // data.amount is already in dollars
        sku: stripeProduct.metadata?.sku || `BSBP-${data.product_id.slice(-6)}`,
        vendor: stripeProduct.metadata?.vendor || 'Black Sheep Business'
      };
    } catch (error) {
      console.error('Could not retrieve product details for order:', error.message);
      // Fallback to basic product info
      product = {
        title: data.product_name || 'Product',
        price: data.amount.toFixed(2),  // data.amount is already in dollars
        sku: `BSBP-${data.product_id.slice(-6)}`,
        vendor: 'Black Sheep Business'
      };
    }
    
    // Create order payload (simplified to avoid API restrictions)
    const orderData = {
      order: {
        email: data.email,
        financial_status: 'paid',
        fulfillment_status: null,
        send_receipt: false,
        send_fulfillment_receipt: false,
        note: `Order created from Stripe payment: ${data.payment_intent_id}\nPurchase Type: ${data.purchase_type}\nProduct ID: ${data.product_id}`,
        tags: `stripe-payment,${data.purchase_type.replace('_', '-')},external-payment`,
        line_items: [
          {
            title: product.title,
            price: product.price,
            quantity: 1,
            vendor: product.vendor,
            requires_shipping: false,
            taxable: false,
            gift_card: false,
            fulfillment_service: 'manual'
          }
        ],
        transactions: [
          {
            kind: 'sale',
            status: 'success',
            amount: (data.amount * 100).toString(),  // Convert dollars to cents for Shopify
            currency: 'USD',
            gateway: 'manual'
          }
        ],
        total_price: data.amount.toFixed(2),  // Keep as dollars for total_price
        subtotal_price: data.amount.toFixed(2),  // Keep as dollars for subtotal_price
        total_tax: '0.00',
        currency: 'USD'
      }
    };
    
    // Add customer ID if found
    if (shopifyCustomerId) {
      orderData.order.customer = {
        id: shopifyCustomerId
      };
    }
    
    // Billing address (simplified - required for orders)
    orderData.order.billing_address = {
      first_name: 'Customer',
      last_name: '',
      address1: 'Online Purchase',
      city: 'Online',
      province: '',
      country: 'US',
      zip: '00000',
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

// Send confirmation email
async function sendEmailConfirmation(data) {
  console.log(`📧 Would send ${data.purchase_type} confirmation email to: ${data.email}`);
  console.log(`📦 Product: ${data.product_name} - $${data.amount}`);
  console.log(`🔄 Returning customer: ${data.is_returning_customer}`);
}

// ═══════════════════════════════════════════════════════════════
// TEST AND DEBUG ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Test Shopify integration (flexible for any product)
app.post('/test-shopify', async (req, res) => {
  const { email, purchase_type, product_id, amount, product_tag } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required for testing' });
  }
  
  try {
    let testData;
    
    if (product_id && amount) {
      // Custom product testing
      const productValidation = await validateProduct(product_id, amount);
      if (!productValidation.isValid) {
        return res.status(400).json({ error: productValidation.error });
      }
      
      testData = {
        email: email,
        amount: amount / 100, // Convert cents to dollars for internal use
        product_id: product_id,
        product_name: productValidation.product.name,
        purchase_type: purchase_type || 'main_course',
        payment_intent_id: 'test_' + Date.now(),
        is_returning_customer: false,
        product_tag: product_tag || 'test-product'
      };
    } else {
      // Default preset testing with specific tags
      const presetData = {
        'main_course': { amount: 47, product_id: 'prod_SfYipzYOk3rdyN', name: 'Black Sheep Business Program', tag: 'main-course' },
        'coaching_upsell': { amount: 297, product_id: 'prod_SfYjjur56WyxMI', name: 'Premium 1-on-1 Coaching', tag: 'coaching-buyer' },
        'software_upsell': { amount: 97, product_id: 'prod_SfdrwTwTQpDt5a', name: 'Software', tag: 'software-buyer' }
      };
      
      const preset = presetData[purchase_type] || presetData['main_course'];
      
      testData = {
        email: email,
        amount: preset.amount,
        product_id: preset.product_id,
        product_name: preset.name,
        purchase_type: purchase_type || 'main_course',
        payment_intent_id: 'test_' + Date.now(),
        is_returning_customer: false,
        product_tag: product_tag || preset.tag
      };
    }
    
    console.log('🧪 Testing Shopify integration with data:', testData);
    
    // Test both customer and order creation
    await createOrUpdateShopifyCustomer(testData);
    await createShopifyOrder(testData);
    
    res.json({ 
      success: true, 
      message: `Successfully processed ${testData.purchase_type} for ${email}`,
      product: testData.product_name,
      amount: testData.amount,
      tags_applied: ['customer', testData.product_tag],
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

// Debug environment variables
app.get('/debug-env', (req, res) => {
  res.json({
    stripe_key_configured: !!process.env.STRIPE_SECRET_KEY,
    shopify_url_configured: !!process.env.SHOPIFY_STORE_URL,
    shopify_token_configured: !!process.env.SHOPIFY_ACCESS_TOKEN,
    webhook_secret_configured: !!process.env.STRIPE_WEBHOOK_SECRET,
    node_env: process.env.NODE_ENV || 'development',
    environment_vars_count: Object.keys(process.env).length
  });
});

// Health check
app.get('/', (req, res) => {
  const isTestMode = process.env.STRIPE_SECRET_KEY?.includes('test');
  
  res.json({ 
    status: 'Black Sheep Payment Server Running! 🐑',
    message: 'Ready to process seamless payments and upsells - Shopify Only Version',
    environment: process.env.NODE_ENV || 'development',
    stripe_mode: isTestMode ? 'test' : 'live',
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
  const isTestMode = process.env.STRIPE_SECRET_KEY?.includes('test');
  
  console.log(`🚀 Black Sheep payment server running on port ${PORT}`);
  console.log(`💳 Ready to process $47 main sales and $297 upsells!`);
  console.log(`🛍️ Shopify-only integration - will auto-sync to Klaviyo`);
  console.log(`🔑 Stripe mode: ${isTestMode ? '🧪 TEST MODE' : '🔴 LIVE MODE'}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/`);
  console.log(`🛡️ Environment: ${process.env.NODE_ENV || 'development'}`);
});
