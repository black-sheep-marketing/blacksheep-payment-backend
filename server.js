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
