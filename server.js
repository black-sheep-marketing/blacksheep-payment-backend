const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Process main course payment
app.post('/process-payment', async (req, res) => {
  try {
    const { payment_method_id, email, amount, product_id } = req.body;
    
    // Create customer in Stripe
    const customer = await stripe.customers.create({
      email: email,
      payment_method: payment_method_id,
      invoice_settings: {
        default_payment_method: payment_method_id,
      },
    });
    
    // Attach payment method to customer
    await stripe.paymentMethods.attach(payment_method_id, {
      customer: customer.id,
    });
    
    // Create and confirm payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // $297 for main product
      currency: 'usd',
      customer: customer.id,
      payment_method: payment_method_id,
      confirmation_method: 'manual',
      confirm: true,
      return_url: 'https://getblacksheep.com/pages/welcome',
      metadata: {
        product_id: product_id,
        customer_email: email,
        is_main_purchase: 'true'
      }
    });
    
    if (paymentIntent.status === 'requires_action') {
      // 3D Secure or other action required
      res.json({
        requires_action: true,
        client_secret: paymentIntent.client_secret,
        customer_id: customer.id,
        payment_method_id: payment_method_id,
        email: email
      });
    } else if (paymentIntent.status === 'succeeded') {
      // Payment successful
      res.json({
        success: true,
        customer_id: customer.id,
        payment_method_id: payment_method_id,
        email: email
      });
    } else {
      res.status(400).json({ error: 'Payment failed' });
    }
    
  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Process one-click upsell
app.post('/process-upsell', async (req, res) => {
  try {
    const { customer_id, payment_method_id, amount, product_id } = req.body;
    
    // Verify customer exists
    const customer = await stripe.customers.retrieve(customer_id);
    if (!customer) {
      return res.status(400).json({ error: 'Customer not found' });
    }
    
    // Create and confirm payment intent for upsell
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // $197 for upsell
      currency: 'usd',
      customer: customer_id,
      payment_method: payment_method_id,
      confirmation_method: 'manual',
      confirm: true,
      metadata: {
        product_id: product_id,
        customer_email: customer.email,
        is_upsell: 'true'
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
    res.status(400).json({ error: error.message });
  }
});

// Webhook to handle successful payments
app.post('/webhook', express.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Will add this to Railway later
  
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle successful payments
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    
    console.log('🎉 Payment succeeded:', paymentIntent.id);
    console.log('📧 Customer email:', paymentIntent.metadata.customer_email);
    console.log('📦 Product:', paymentIntent.metadata.product_id);
    console.log('🔼 Is upsell:', paymentIntent.metadata.is_upsell || 'false');
    
    // Send confirmation email
    sendConfirmationEmail(paymentIntent);
  }
  
  res.json({received: true});
});

// Email confirmation function
async function sendConfirmationEmail(paymentIntent) {
  const { customer_email, is_upsell, product_id } = paymentIntent.metadata;
  const amount = paymentIntent.amount / 100; // Convert cents to dollars
  
  console.log(`📨 Processing purchase for: ${customer_email}`);
  console.log(`💰 Payment amount: ${amount}`);
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
  
  // Send to Klaviyo
  await sendToKlaviyo({
    email: customer_email,
    amount: amount,
    product_id: product_id,
    product_name: productName,
    purchase_type: purchaseType,
    payment_intent_id: paymentIntent.id
  });
  
  // Send to Google Sheets
  await sendToGoogleSheets({
    email: customer_email,
    amount: amount,
    product_id: product_id,
    product_name: productName,
    purchase_type: purchaseType,
    payment_intent_id: paymentIntent.id,
    timestamp: new Date().toISOString()
  });
  
  // 🆕 ADD SHOPIFY INTEGRATION HERE
  await createOrUpdateShopifyCustomer({
    email: customer_email,
    amount: amount,
    product_id: product_id,
    product_name: productName,
    purchase_type: purchaseType,
    payment_intent_id: paymentIntent.id
  });
  
  // Send confirmation email (you can use Klaviyo for this too)
  await sendEmailConfirmation({
    email: customer_email,
    amount: amount,
    product_name: productName,
    purchase_type: purchaseType
  });
}

// Send data to Klaviyo
async function sendToKlaviyo(data) {
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY; // Add this to your Render environment variables
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID; // Add this to your Render environment variables
  
  if (!KLAVIYO_API_KEY) {
    console.log('⚠️ Klaviyo API key not configured');
    return;
  }
  
  try {
    // Add/update profile in Klaviyo
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
              total_spent: data.amount, // You might want to calculate cumulative total
              purchase_count: 1 // You might want to increment this
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
            profile: {
              email: data.email
            },
            metric: {
              name: 'Purchase Completed'
            },
            properties: {
              purchase_type: data.purchase_type,
              product_name: data.product_name,
              product_id: data.product_id,
              amount: data.amount,
              payment_intent_id: data.payment_intent_id
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

// Send data to Google Sheets
async function sendToGoogleSheets(data) {
  const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL; // Add this to your Render environment variables
  
  if (!GOOGLE_SHEETS_URL) {
    console.log('⚠️ Google Sheets webhook URL not configured');
    return;
  }
  
  try {
    const response = await fetch(GOOGLE_SHEETS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: data.email,
        amount: data.amount,
        product_id: data.product_id,
        product_name: data.product_name,
        purchase_type: data.purchase_type,
        payment_intent_id: data.payment_intent_id,
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

// 🆕🆕🆕 ADD ALL THESE SHOPIFY FUNCTIONS 🆕🆕🆕

// Simplified Shopify integration without metafields
async function createOrUpdateShopifyCustomer(data) {
  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    console.log('⚠️ Shopify credentials not configured');
    console.log('SHOPIFY_STORE_URL:', SHOPIFY_STORE_URL ? 'Set' : 'Missing');
    console.log('SHOPIFY_ACCESS_TOKEN:', SHOPIFY_ACCESS_TOKEN ? 'Set' : 'Missing');
    return;
  }
  
  console.log(`🛍️ Processing Shopify customer: ${data.email}`);
  console.log(`📦 Purchase type: ${data.purchase_type}`);
  
  try {
    // Get tags for this purchase type
    const newTags = getTagsForPurchase(data.purchase_type);
    console.log(`🏷️ Tags to apply: ${newTags.join(', ')}`);
    
    // Search for existing customer
    const searchUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(data.email)}`;
    console.log(`🔍 Searching for customer...`);
    
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      throw new Error(`Shopify search failed: ${searchResponse.status} - ${errorText}`);
    }
    
    const searchResult = await searchResponse.json();
    console.log(`📊 Found ${searchResult.customers?.length || 0} existing customers`);
    
    if (searchResult.customers && searchResult.customers.length > 0) {
      // Update existing customer
      const customer = searchResult.customers[0];
      console.log(`👤 Updating existing customer: ${customer.id}`);
      console.log(`🏷️ Current tags: ${customer.tags || 'None'}`);
      
      // Merge tags (avoid duplicates)
      const existingTags = customer.tags ? customer.tags.split(', ').map(tag => tag.trim()) : [];
      const allTags = [...new Set([...existingTags, ...newTags])];
      
      // Update customer
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
            note: updateCustomerNote(customer.note, data)
          }
        })
      });
      
      if (updateResponse.ok) {
        console.log(`✅ Updated customer with tags: ${allTags.join(', ')}`);
      } else {
        const errorData = await updateResponse.text();
        throw new Error(`Update failed: ${updateResponse.status} - ${errorData}`);
      }
      
    } else {
      // Create new customer
      console.log(`👤 Creating new customer...`);
      
      const createResponse = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/2023-10/customers.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customer: {
            email: data.email,
            tags: newTags.join(', '),
            note: buildCustomerNote(data),
            verified_email: true,
            accepts_marketing: true
          }
        })
      });
      
      if (createResponse.ok) {
        const newCustomer = await createResponse.json();
        console.log(`✅ Created customer with tags: ${newTags.join(', ')}`);
        console.log(`🆔 Customer ID: ${newCustomer.customer.id}`);
      } else {
        const errorData = await createResponse.text();
        throw new Error(`Create failed: ${createResponse.status} - ${errorData}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Shopify error:', error.message);
    // Continue processing even if Shopify fails
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
- Product ID: ${data.product_id}`;
}

// Update existing customer note
function updateCustomerNote(existingNote, data) {
  const timestamp = new Date().toLocaleDateString();
  const newPurchase = `- ${data.product_name}: $${data.amount} (${timestamp})`;
  
  if (!existingNote) {
    return buildCustomerNote(data);
  }
  
  // If note already has purchase history, add to it
  if (existingNote.includes('Purchase History:')) {
    // Find the end of the purchase list
    const lines = existingNote.split('\n');
    const purchaseIndex = lines.findIndex(line => line.includes('Purchase History:'));
    
    if (purchaseIndex !== -1) {
      // Insert new purchase after "Purchase History:" line
      lines.splice(purchaseIndex + 1, 0, newPurchase);
      return lines.join('\n');
    }
  }
  
  // If no purchase history section, add it
  return existingNote + '\n\nPurchase History:\n' + newPurchase;
}

// Clean tag calculation function
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

// 🆕🆕🆕 ADD THESE TEST ENDPOINTS 🆕🆕🆕

// Test Shopify connection and customer creation
app.post('/test-shopify', async (req, res) => {
  const { email, purchase_type } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email required for testing' });
  }
  
  try {
    // Test data
    const testData = {
      email: email,
      amount: purchase_type === 'main_course' ? 47 : 297,
      product_id: purchase_type === 'main_course' ? 'prod_SfYipzYOk3rdyN' : 'prod_SfYjjur56WyxMI',
      product_name: purchase_type === 'main_course' ? 'Black Sheep Business Program' : 'Premium 1-on-1 Coaching',
      purchase_type: purchase_type || 'main_course',
      payment_intent_id: 'test_' + Date.now()
    };
    
    console.log('🧪 Testing Shopify integration with data:', testData);
    
    await createOrUpdateShopifyCustomer(testData);
    
    res.json({ 
      success: true, 
      message: `Successfully processed ${purchase_type} for ${email}`,
      tags_applied: getTagsForPurchase(purchase_type)
    });
    
  } catch (error) {
    console.error('❌ Shopify test failed:', error);
    res.status(500).json({ 
      error: error.message,
      details: 'Check server logs for full error details'
    });
  }
});

// Test endpoint to check current customer tags
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

// Send confirmation email
async function sendEmailConfirmation(data) {
  // Option A: Use Klaviyo to send emails (recommended)
  // You can trigger Klaviyo flows based on the events you just sent
  
  // Option B: Use your own email service
  console.log(`📧 Would send ${data.purchase_type} confirmation email to: ${data.email}`);
  console.log(`📦 Product: ${data.product_name} - ${data.amount}`);
  
  // Example with nodemailer (if you want to send directly):
  /*
  const nodemailer = require('nodemailer');
  
  const transporter = nodemailer.createTransporter({
    // Your email config
  });
  
  const emailTemplate = getEmailTemplate(data.purchase_type, data);
  
  await transporter.sendMail({
    from: 'noreply@getblacksheep.com',
    to: data.email,
    subject: `Thank you for your purchase - ${data.product_name}`,
    html: emailTemplate
  });
  */
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Black Sheep Payment Server Running! 🐑',
    message: 'Ready to process seamless payments and upsells',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint to verify Stripe connection
app.get('/test-stripe', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ 
      status: 'Stripe connected successfully! ✅',
      currency: balance.available[0]?.currency || 'usd'
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
});
