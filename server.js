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
  
  console.log(`📨 Sending confirmation email to: ${customer_email}`);
  console.log(`💰 Payment amount: $${amount}`);
  console.log(`📋 Product: ${is_upsell === 'true' ? 'Premium Coaching Upsell' : 'Black Sheep Business Program'}`);
  
  // TODO: Implement your email sending logic here
  // Options:
  // 1. Nodemailer + Gmail SMTP
  // 2. SendGrid API
  // 3. Mailgun API
  // 4. ConvertKit API
  // 5. Zapier webhook
  
  // Example webhook to Zapier (easiest option):
  /*
  const zapierWebhookUrl = 'https://hooks.zapier.com/hooks/catch/YOUR_WEBHOOK_ID/';
  
  await fetch(zapierWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: customer_email,
      amount: amount,
      product: is_upsell === 'true' ? 'coaching' : 'main_program',
      timestamp: new Date().toISOString()
    })
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
  console.log(`💳 Ready to process $297 main sales and $197 upsells!`);
  console.log(`🌐 Health check: http://localhost:${PORT}/`);
});