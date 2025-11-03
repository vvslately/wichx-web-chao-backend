import express from 'express';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 5001;

// JWT Secret Key
const JWT_SECRET = '32670cc39ca9333bedb30406cc22c4bc';

// Database configuration
const dbConfig = {
  host: '210.246.215.19',
  port: 3306,
  user: 'okzcuser',
  password: 'StrongPass123!',
  database: 'okzc',
  ssl: {
    rejectUnauthorized: false
  }
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // อนุญาต localhost สำหรับ dev
    if (!origin || 
        origin.startsWith('http://localhost') || 
        origin.startsWith('https://localhost')) {
      return callback(null, true);
    }

    // อนุญาตทุก subdomain ของ okzc.xyz
    if (/\.okzc\.xyz$/.test(origin) || origin === 'https://okzc.xyz') {
      return callback(null, true);
    }

    // ไม่อนุญาต origin อื่น
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Multi-tenant middleware - Extract subdomain and find customer_id
const multiTenantMiddleware = async (req, res, next) => {
  try {
    // Get host from request
    const host = req.get('host') || req.get('x-forwarded-host') || '';
    
    // Check if it's localhost first - auto use 'death'
    // This includes requests FROM localhost frontend TO external API
    const origin = req.get('origin') || '';
    if (host.includes('localhost') || origin.includes('localhost')) {
      const [sites] = await pool.execute(
        'SELECT customer_id, website_name FROM auth_sites WHERE website_name = ?',
        ['death']
      );
      
      if (sites.length > 0) {
        const site = sites[0];
        req.customer_id = parseInt(site.customer_id);
        req.website_name = site.website_name;
      } else {
        req.customer_id = null;
        req.website_name = null;
      }
      return next();
    }
    
    let subdomain = req.get('x-subdomain') || req.get('x-website-name');
    
    // If no custom header, try to extract from origin header
    if (!subdomain) {
      const origin = req.get('origin') || '';
      if (origin.includes('okzc.xyz')) {
        // Extract subdomain from origin: https://subdomain.okzc.xyz
        const originMatch = origin.match(/https?:\/\/([^.]+)\.okzc\.xyz/);
        if (originMatch) {
          subdomain = originMatch[1];
        }
      }
    }
    
    // If still no subdomain, try to extract from host (for direct API calls)
    if (!subdomain) {
      subdomain = host.split('.')[0];
    }
    
    // Skip multi-tenant for main domain
    if (host === 'okzc.xyz' || !subdomain || subdomain === 'www') {
      req.customer_id = null;
      req.website_name = null;
      return next();
    }
    
    // Debug logging for production troubleshooting
    console.log('Multi-tenant Debug:', {
      host,
      origin: req.get('origin'),
      xSubdomain: req.get('x-subdomain'),
      xWebsiteName: req.get('x-website-name'),
      extractedSubdomain: subdomain,
      userAgent: req.get('user-agent'),
      isLocalhostHost: host.includes('localhost'),
      isLocalhostOrigin: origin.includes('localhost')
    });
    
    // Find customer_id from auth_sites table using website_name
    const [sites] = await pool.execute(
      'SELECT customer_id, website_name FROM auth_sites WHERE website_name = ?',
      [subdomain]
    );
    
    if (sites.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Website not found or inactive',
        subdomain: subdomain,
        debug: {
          host,
          origin: req.get('origin'),
          xSubdomain: req.get('x-subdomain'),
          xWebsiteName: req.get('x-website-name')
        }
      });
    }
    
    const site = sites[0];
    req.customer_id = parseInt(site.customer_id);
    req.website_name = site.website_name;
    
    next();
  } catch (error) {
    console.error('Multi-tenant middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};



// Apply multi-tenant middleware to all routes
app.use(multiTenantMiddleware);

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Access token required' 
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        message: 'Invalid or expired token' 
      });
    }
    req.user = user;
    next();
  });
};

// Role-based permission middleware
const requirePermission = (permission) => {
  return async (req, res, next) => {
    try {
      const userId = req.user.id;

      // Get user's role and permissions
      const [userRoles] = await pool.execute(
        `SELECT 
          u.role,
          r.${permission}
        FROM users u
        LEFT JOIN roles r ON u.role = r.rank_name
        WHERE u.id = ?`,
        [userId]
      );

      if (userRoles.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      const userRole = userRoles[0];

      // If no role found in roles table, deny access
      if (!userRole[permission]) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Required permission: ${permission}`,
          user_role: userRole.role || 'member'
        });
      }

      // Check if user has the required permission
      if (!userRole[permission]) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Required permission: ${permission}`,
          user_role: userRole.role
        });
      }

      next();
    } catch (error) {
      console.error('Permission check error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  };
};

// Helper function to check multiple permissions
const requireAnyPermission = (permissions) => {
  return async (req, res, next) => {
    try {
      const userId = req.user.id;

      // Get user's role and permissions
      const [userRoles] = await pool.execute(
        `SELECT 
          u.role,
          ${permissions.map(p => `r.${p}`).join(', ')}
        FROM users u
        LEFT JOIN roles r ON u.role = r.rank_name
        WHERE u.id = ?`,
        [userId]
      );

      if (userRoles.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      const userRole = userRoles[0];

      // Check if user has any of the required permissions
      const hasPermission = permissions.some(permission => userRole[permission]);

      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Required any of these permissions: ${permissions.join(', ')}`,
          user_role: userRole.role || 'member'
        });
      }

      next();
    } catch (error) {
      console.error('Permission check error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  };
};


// Basic health check
app.get('/', (req, res) => {
  res.json({
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Signup endpoint
app.post('/signup', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const { fullname, password, pin_code } = req.body;

    // Validate required fields
    if (!fullname || !password || !pin_code) {
      return res.status(400).json({
        success: false,
        message: 'Fullname, password, and pin_code are required'
      });
    }

    // Check customer status before signup
    const [sites] = await pool.execute(
      'SELECT status FROM auth_sites WHERE customer_id = ?',
      [req.customer_id]
    );

    if (sites.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
        status: 'customer_not_found'
      });
    }

    const customerStatus = sites[0].status;
    if (customerStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'Account suspended',
        status: 'suspended'
      });
    }

    // Check if user already exists for this customer
    const [existingUsers] = await pool.execute(
      'SELECT id FROM users WHERE fullname = ? AND customer_id = ?',
      [fullname, req.customer_id]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User with this fullname already exists'
      });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Generate a dummy email for compatibility with existing schema
    const dummyEmail = `user_${Date.now()}@${req.customer_id}.local`;

    // Insert new user with customer_id
    const [result] = await pool.execute(
      'INSERT INTO users (customer_id, fullname, email, password, pin_code) VALUES (?, ?, ?, ?, ?)',
      [req.customer_id, fullname, dummyEmail, hashedPassword, pin_code]
    );

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: result.insertId, 
        fullname: fullname,
        customer_id: req.customer_id
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      token: token,
      status: 'active',
      user: {
        id: result.insertId,
        fullname: fullname
      }
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const { fullname, password } = req.body;

    // Validate required fields
    if (!fullname || !password) {
      return res.status(400).json({
        success: false,
        message: 'Fullname and password are required'
      });
    }

    // Check customer status before login
    const [sites] = await pool.execute(
      'SELECT status FROM auth_sites WHERE customer_id = ?',
      [req.customer_id]
    );

    if (sites.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
        status: 'customer_not_found'
      });
    }

    const customerStatus = sites[0].status;
    if (customerStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'Account suspended',
        status: 'suspended'
      });
    }

    // Find user by fullname and customer_id
    const [users] = await pool.execute(
      'SELECT id, fullname, password, money, points, role FROM users WHERE fullname = ? AND customer_id = ?',
      [fullname, req.customer_id]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid fullname or password'
      });
    }

    const user = users[0];

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid fullname or password'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        fullname: user.fullname,
        customer_id: req.customer_id
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token: token,
      status: 'active',
      user: {
        id: user.id,
        fullname: user.fullname,
        money: user.money,
        points: user.points,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get user profile (protected route)
app.get('/my-profile', authenticateToken, async (req, res) => {
  try {
    // Check if customer_id matches token
    if (req.user.customer_id !== req.customer_id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied - customer mismatch'
      });
    }

    const [users] = await pool.execute(
      'SELECT id, fullname, email, money, points, role, created_at FROM users WHERE id = ? AND customer_id = ?',
      [req.user.id, req.customer_id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];

    res.json({
      success: true,
      message: 'Profile retrieved successfully',
      user: {
        id: user.id,
        fullname: user.fullname,
        email: user.email,
        money: user.money,
        points: user.points,
        role: user.role,
        created_at: user.created_at
      }
    });

  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Logout endpoint (client-side token removal)
app.post('/logout', authenticateToken, (req, res) => {
  res.json({
    success: true,
    message: 'Logout successful. Please remove token from client-side storage.'
  });
});

// Verify token endpoint
app.get('/verify-token', authenticateToken, (req, res) => {
  // Check if customer_id matches token
  if (req.user.customer_id !== req.customer_id) {
    return res.status(403).json({
      success: false,
      message: 'Access denied - customer mismatch'
    });
  }

  res.json({
    success: true,
    message: 'Token is valid',
    user: {
      id: req.user.id,
      email: req.user.email,
      fullname: req.user.fullname,
      customer_id: req.user.customer_id
    }
  });
});

// Get theme settings endpoint
app.get('/theme-settings', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    // Get theme settings for specific customer
    const [themes] = await pool.execute(
      'SELECT * FROM theme_settings WHERE customer_id = ? ORDER BY id LIMIT 1',
      [req.customer_id]
    );

    if (themes.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No theme settings found for this customer'
      });
    }

    const theme = themes[0];

    res.json({
      success: true,
      message: 'Theme settings retrieved successfully',
      theme: {
        id: theme.id,
        primary_color: theme.primary_color,
        secondary_color: theme.secondary_color,
        background_color: theme.background_color,
        text_color: theme.text_color,
        theme_mode: theme.theme_mode,
        updated_at: theme.updated_at
      }
    });

  } catch (error) {
    console.error('Theme settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update theme settings endpoint
app.put('/update-theme-settings', authenticateToken, requirePermission('can_manage_settings'), async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const {
      primary_color,
      secondary_color,
      background_color,
      text_color,
      theme_mode
    } = req.body;

    // Check if theme settings exist for this customer
    const [existingThemes] = await pool.execute(
      'SELECT id FROM theme_settings WHERE customer_id = ?',
      [req.customer_id]
    );

    if (existingThemes.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No theme settings found for this customer. Cannot create new theme settings.'
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (primary_color !== undefined) {
      updateFields.push('primary_color = ?');
      updateValues.push(primary_color);
    }
    if (secondary_color !== undefined) {
      updateFields.push('secondary_color = ?');
      updateValues.push(secondary_color);
    }
    if (background_color !== undefined) {
      updateFields.push('background_color = ?');
      updateValues.push(background_color);
    }
    if (text_color !== undefined) {
      updateFields.push('text_color = ?');
      updateValues.push(text_color);
    }
    if (theme_mode !== undefined) {
      updateFields.push('theme_mode = ?');
      updateValues.push(theme_mode);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    // Add customer_id to the end of values array
    updateValues.push(req.customer_id);

    // Execute update
    const [result] = await pool.execute(
      `UPDATE theme_settings SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?`,
      updateValues
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Theme settings not found or no changes made'
      });
    }

    // Get updated theme settings
    const [updatedThemes] = await pool.execute(
      'SELECT * FROM theme_settings WHERE customer_id = ?',
      [req.customer_id]
    );

    const updatedTheme = updatedThemes[0];

    res.json({
      success: true,
      message: 'Theme settings updated successfully',
      theme: {
        id: updatedTheme.id,
        primary_color: updatedTheme.primary_color,
        secondary_color: updatedTheme.secondary_color,
        background_color: updatedTheme.background_color,
        text_color: updatedTheme.text_color,
        theme_mode: updatedTheme.theme_mode,
        updated_at: updatedTheme.updated_at
      }
    });

  } catch (error) {
    console.error('Update theme settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get web config endpoint
app.get('/get-web-config', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    // Get config for specific customer (excluding theme)
    const [configs] = await pool.execute(
      `SELECT id, owner_phone, site_name, site_logo, meta_title, meta_description, 
       meta_keywords, meta_author, discord_link, discord_webhook, banner_link, 
       banner2_link, banner3_link, navigation_banner_1, navigation_link_1,
       navigation_banner_2, navigation_link_2, navigation_banner_3, navigation_link_3,
       navigation_banner_4, navigation_link_4, background_image, footer_image, load_logo, 
       footer_logo, ad_banner, bank_account_name, bank_account_number, bank_account_name_thai, bank_account_tax, api, created_at, updated_at 
       FROM config WHERE customer_id = ? ORDER BY id LIMIT 1`,
      [req.customer_id]
    );

    if (configs.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No web config found for this customer'
      });
    }

    const config = configs[0];

    res.json({
      success: true,
      message: 'Web config retrieved successfully',
      config: {
        id: config.id,
        owner_phone: config.owner_phone,
        site_name: config.site_name,
        site_logo: config.site_logo,
        meta_title: config.meta_title,
        meta_description: config.meta_description,
        meta_keywords: config.meta_keywords,
        meta_author: config.meta_author,
        discord_link: config.discord_link,
        discord_webhook: config.discord_webhook,
        banner_link: config.banner_link,
        banner2_link: config.banner2_link,
        banner3_link: config.banner3_link,
        navigation_banner_1: config.navigation_banner_1,
        navigation_link_1: config.navigation_link_1,
        navigation_banner_2: config.navigation_banner_2,
        navigation_link_2: config.navigation_link_2,
        navigation_banner_3: config.navigation_banner_3,
        navigation_link_3: config.navigation_link_3,
        navigation_banner_4: config.navigation_banner_4,
        navigation_link_4: config.navigation_link_4,
        background_image: config.background_image,
        footer_image: config.footer_image,
        load_logo: config.load_logo,
        footer_logo: config.footer_logo,
        ad_banner: config.ad_banner,
        bank_account_name: config.bank_account_name,
        bank_account_number: config.bank_account_number,
        bank_account_name_thai: config.bank_account_name_thai,
        bank_account_tax: config.bank_account_tax,
        api: config.api,
        created_at: config.created_at,
        updated_at: config.updated_at
      }
    });

  } catch (error) {
    console.error('Web config error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});





// Update web config endpoint (excluding theme)
app.put('/update-web-config', authenticateToken, requirePermission('can_manage_settings'), async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const {
      owner_phone,
      site_name,
      site_logo,
      meta_title,
      meta_description,
      meta_keywords,
      meta_author,
      discord_link,
      discord_webhook,
      banner_link,
      banner2_link,
      banner3_link,
      navigation_banner_1,
      navigation_link_1,
      navigation_banner_2,
      navigation_link_2,
      navigation_banner_3,
      navigation_link_3,
      navigation_banner_4,
      navigation_link_4,
      background_image,
      footer_image,
      load_logo,
      footer_logo,
      ad_banner,
      bank_account_name,
      bank_account_number,
      bank_account_name_thai,
      bank_account_tax,
      api
    } = req.body;

    // Check if config exists for this customer
    const [existingConfigs] = await pool.execute(
      'SELECT id FROM config WHERE customer_id = ?',
      [req.customer_id]
    );

    if (existingConfigs.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No config found for this customer. Cannot create new config.'
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (owner_phone !== undefined) {
      updateFields.push('owner_phone = ?');
      updateValues.push(owner_phone);
    }
    if (site_name !== undefined) {
      updateFields.push('site_name = ?');
      updateValues.push(site_name);
    }
    if (site_logo !== undefined) {
      updateFields.push('site_logo = ?');
      updateValues.push(site_logo);
    }
    if (meta_title !== undefined) {
      updateFields.push('meta_title = ?');
      updateValues.push(meta_title);
    }
    if (meta_description !== undefined) {
      updateFields.push('meta_description = ?');
      updateValues.push(meta_description);
    }
    if (meta_keywords !== undefined) {
      updateFields.push('meta_keywords = ?');
      updateValues.push(meta_keywords);
    }
    if (meta_author !== undefined) {
      updateFields.push('meta_author = ?');
      updateValues.push(meta_author);
    }
    if (discord_link !== undefined) {
      updateFields.push('discord_link = ?');
      updateValues.push(discord_link);
    }
    if (discord_webhook !== undefined) {
      updateFields.push('discord_webhook = ?');
      updateValues.push(discord_webhook);
    }
    if (banner_link !== undefined) {
      updateFields.push('banner_link = ?');
      updateValues.push(banner_link);
    }
    if (banner2_link !== undefined) {
      updateFields.push('banner2_link = ?');
      updateValues.push(banner2_link);
    }
    if (banner3_link !== undefined) {
      updateFields.push('banner3_link = ?');
      updateValues.push(banner3_link);
    }
    if (background_image !== undefined) {
      updateFields.push('background_image = ?');
      updateValues.push(background_image);
    }
    if (footer_image !== undefined) {
      updateFields.push('footer_image = ?');
      updateValues.push(footer_image);
    }
    if (load_logo !== undefined) {
      updateFields.push('load_logo = ?');
      updateValues.push(load_logo);
    }
    if (footer_logo !== undefined) {
      updateFields.push('footer_logo = ?');
      updateValues.push(footer_logo);
    }
    if (ad_banner !== undefined) {
      updateFields.push('ad_banner = ?');
      updateValues.push(ad_banner);
    }
    if (navigation_banner_1 !== undefined) {
      updateFields.push('navigation_banner_1 = ?');
      updateValues.push(navigation_banner_1);
    }
    if (navigation_link_1 !== undefined) {
      updateFields.push('navigation_link_1 = ?');
      updateValues.push(navigation_link_1);
    }
    if (navigation_banner_2 !== undefined) {
      updateFields.push('navigation_banner_2 = ?');
      updateValues.push(navigation_banner_2);
    }
    if (navigation_link_2 !== undefined) {
      updateFields.push('navigation_link_2 = ?');
      updateValues.push(navigation_link_2);
    }
    if (navigation_banner_3 !== undefined) {
      updateFields.push('navigation_banner_3 = ?');
      updateValues.push(navigation_banner_3);
    }
    if (navigation_link_3 !== undefined) {
      updateFields.push('navigation_link_3 = ?');
      updateValues.push(navigation_link_3);
    }
    if (navigation_banner_4 !== undefined) {
      updateFields.push('navigation_banner_4 = ?');
      updateValues.push(navigation_banner_4);
    }
    if (navigation_link_4 !== undefined) {
      updateFields.push('navigation_link_4 = ?');
      updateValues.push(navigation_link_4);
    }
    if (bank_account_name !== undefined) {
      updateFields.push('bank_account_name = ?');
      updateValues.push(bank_account_name);
    }
    if (bank_account_number !== undefined) {
      updateFields.push('bank_account_number = ?');
      updateValues.push(bank_account_number);
    }
    if (bank_account_name_thai !== undefined) {
      updateFields.push('bank_account_name_thai = ?');
      updateValues.push(bank_account_name_thai);
    }

    if (bank_account_tax !== undefined) {
      updateFields.push('bank_account_tax = ?');
      updateValues.push(bank_account_tax);
    }
    if (api !== undefined) {
      updateFields.push('api = ?');
      updateValues.push(api);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    // Add customer_id to the end of values array
    updateValues.push(req.customer_id);

    // Execute update
    const [result] = await pool.execute(
      `UPDATE config SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?`,
      updateValues
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Config not found or no changes made'
      });
    }

    // Get updated config
    const [updatedConfigs] = await pool.execute(
      `SELECT id, owner_phone, site_name, site_logo, meta_title, meta_description, 
       meta_keywords, meta_author, discord_link, discord_webhook, banner_link, 
       banner2_link, banner3_link, navigation_banner_1, navigation_link_1,
       navigation_banner_2, navigation_link_2, navigation_banner_3, navigation_link_3,
       navigation_banner_4, navigation_link_4, background_image, footer_image, load_logo, 
       footer_logo, ad_banner, bank_account_name, bank_account_number, bank_account_name_thai, bank_account_tax, api, created_at, updated_at 
       FROM config WHERE customer_id = ?`,
      [req.customer_id]
    );

    const updatedConfig = updatedConfigs[0];

    res.json({
      success: true,
      message: 'Web config updated successfully',
      config: {
        id: updatedConfig.id,
        owner_phone: updatedConfig.owner_phone,
        site_name: updatedConfig.site_name,
        site_logo: updatedConfig.site_logo,
        meta_title: updatedConfig.meta_title,
        meta_description: updatedConfig.meta_description,
        meta_keywords: updatedConfig.meta_keywords,
        meta_author: updatedConfig.meta_author,
        discord_link: updatedConfig.discord_link,
        discord_webhook: updatedConfig.discord_webhook,
        banner_link: updatedConfig.banner_link,
        banner2_link: updatedConfig.banner2_link,
        banner3_link: updatedConfig.banner3_link,
        navigation_banner_1: updatedConfig.navigation_banner_1,
        navigation_link_1: updatedConfig.navigation_link_1,
        navigation_banner_2: updatedConfig.navigation_banner_2,
        navigation_link_2: updatedConfig.navigation_link_2,
        navigation_banner_3: updatedConfig.navigation_banner_3,
        navigation_link_3: updatedConfig.navigation_link_3,
        navigation_banner_4: updatedConfig.navigation_banner_4,
        navigation_link_4: updatedConfig.navigation_link_4,
        background_image: updatedConfig.background_image,
        footer_image: updatedConfig.footer_image,
        load_logo: updatedConfig.load_logo,
        footer_logo: updatedConfig.footer_logo,
        ad_banner: updatedConfig.ad_banner,
        bank_account_name: updatedConfig.bank_account_name,
        bank_account_number: updatedConfig.bank_account_number,
        bank_account_name_thai: updatedConfig.bank_account_name_thai,
        bank_account_tax: updatedConfig.bank_account_tax,
        api: updatedConfig.api,
        created_at: updatedConfig.created_at,
        updated_at: updatedConfig.updated_at
      }
    });

  } catch (error) {
    console.error('Update web config error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get categories endpoint (hierarchical structure)
app.get('/categories', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    // Get all categories for specific customer ordered by priority and title
    const [categories] = await pool.execute(
      'SELECT id, parent_id, title, subtitle, image, category, featured, isActive, priority, created_at FROM categories WHERE customer_id = ? AND isActive = 1 ORDER BY priority DESC, title ASC',
      [req.customer_id]
    );

    // Build hierarchical structure
    const categoryMap = new Map();
    const rootCategories = [];

    // First pass: create map of all categories
    categories.forEach(category => {
      categoryMap.set(category.id, {
        ...category,
        children: []
      });
    });

    // Second pass: build hierarchy
    categories.forEach(category => {
      const categoryObj = categoryMap.get(category.id);
      
      if (category.parent_id === null) {
        // Root category
        rootCategories.push(categoryObj);
      } else {
        // Child category
        const parent = categoryMap.get(category.parent_id);
        if (parent) {
          parent.children.push(categoryObj);
        }
      }
    });

    res.json({
      success: true,
      message: 'Categories retrieved successfully',
      categories: rootCategories,
      total: categories.length
    });

  } catch (error) {
    console.error('Categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get flat categories endpoint (non-nested structure)
app.get('/categories/flat', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    // Get all categories in flat structure for specific customer ordered by priority and title
    const [categories] = await pool.execute(
      'SELECT id, parent_id, title, subtitle, image, category, featured, isActive, priority, created_at FROM categories WHERE customer_id = ? AND isActive = 1 ORDER BY priority DESC, title ASC',
      [req.customer_id]
    );

    res.json({
      success: true,
      message: 'Flat categories retrieved successfully',
      categories: categories,
      total: categories.length
    });

  } catch (error) {
    console.error('Flat categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get nested categories endpoint (hierarchical structure)
app.get('/categories/nested', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    // Get all categories for specific customer ordered by priority and title
    const [categories] = await pool.execute(
      'SELECT id, parent_id, title, subtitle, image, category, featured, isActive, priority, created_at FROM categories WHERE customer_id = ? AND isActive = 1 ORDER BY priority DESC, title ASC',
      [req.customer_id]
    );
    
    // Build hierarchical structure
    const categoryMap = new Map();
    const rootCategories = [];

    // First pass: create map of all categories
    categories.forEach(category => {
      categoryMap.set(category.id, {
        ...category,
        children: []
      });
    });

    // Second pass: build hierarchy
    categories.forEach(category => {
      const categoryObj = categoryMap.get(category.id);
      
      if (category.parent_id === null) {
        // Root category
        rootCategories.push(categoryObj);
      } else {
        // Child category
        const parent = categoryMap.get(category.parent_id);
        if (parent) {
          parent.children.push(categoryObj);
        }
      }
    });

    res.json({
      success: true,
      message: 'Nested categories retrieved successfully',
      categories: rootCategories,
      total: categories.length
    });

  } catch (error) {
    console.error('Nested categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get products by category ID endpoint
app.get('/categories/:categoryId/products', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const categoryId = req.params.categoryId;
    // Validate category ID
    if (!categoryId || isNaN(categoryId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid category ID is required'
      });
    }

    // Check if category exists for this customer
    const [categoryCheck] = await pool.execute(
      'SELECT id, title FROM categories WHERE id = ? AND customer_id = ? AND isActive = 1',
      [categoryId, req.customer_id]
    );

    if (categoryCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Category not found or inactive'
      });
    }

    // Get products for the category and customer
    const [products] = await pool.execute(
      `SELECT 
        id, category_id, title, subtitle, price, reseller_price, stock, 
        duration, image, download_link, isSpecial, featured, isActive, 
        isWarrenty, warrenty_text, primary_color, secondary_color, 
        created_at, priority, discount_percent
      FROM products 
      WHERE category_id = ? AND customer_id = ? AND isActive = 1 
      ORDER BY priority DESC, title ASC`,
      [categoryId, req.customer_id]
    );

    // Calculate discounted prices for each product
    const productsWithDiscount = products.map(product => {
      const originalPrice = parseFloat(product.price);
      const discountPercent = parseInt(product.discount_percent) || 0;
      const discountedPrice = originalPrice * (1 - discountPercent / 100);
      
      return {
        ...product,
        original_price: originalPrice,
        discounted_price: discountedPrice,
        has_discount: discountPercent > 0,
        discount_savings: originalPrice - discountedPrice
      };
    });

    res.json({
      success: true,
      message: 'Products retrieved successfully',
      category: categoryCheck[0],
      products: productsWithDiscount,
      total: productsWithDiscount.length
    });

  } catch (error) {
    console.error('Products by category error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get single product by ID endpoint
app.get('/products/:productId', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const productId = req.params.productId;

    // Validate product ID
    if (!productId || isNaN(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid product ID is required'
      });
    }

    // Get product details for specific customer
    const [products] = await pool.execute(
      `SELECT 
        p.id, p.category_id, p.title, p.subtitle, p.price, p.reseller_price, p.stock, 
        p.duration, p.image, p.download_link, p.isSpecial, p.featured, p.isActive, 
        p.isWarrenty, p.warrenty_text, p.primary_color, p.secondary_color, 
        p.created_at, p.priority, p.discount_percent,
        c.title as category_title, c.category as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ? AND p.customer_id = ? AND p.isActive = 1`,
      [productId, req.customer_id]
    );

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or inactive'
      });
    }

    const product = products[0];

    // Calculate discounted price for single product
    const originalPrice = parseFloat(product.price);
    const discountPercent = parseInt(product.discount_percent) || 0;
    const discountedPrice = originalPrice * (1 - discountPercent / 100);

    res.json({
      success: true,
      message: 'Product retrieved successfully',
      product: {
        id: product.id,
        category_id: product.category_id,
        category_title: product.category_title,
        category_slug: product.category_slug,
        title: product.title,
        subtitle: product.subtitle,
        price: product.price,
        original_price: originalPrice,
        discounted_price: discountedPrice,
        has_discount: discountPercent > 0,
        discount_savings: originalPrice - discountedPrice,
        reseller_price: product.reseller_price,
        stock: product.stock,
        duration: product.duration,
        image: product.image,
        download_link: product.download_link,
        isSpecial: product.isSpecial,
        featured: product.featured,
        isActive: product.isActive,
        isWarrenty: product.isWarrenty,
        warrenty_text: product.warrenty_text,
        primary_color: product.primary_color,
        secondary_color: product.secondary_color,
        created_at: product.created_at,
        priority: product.priority,
        discount_percent: product.discount_percent
      }
    });

  } catch (error) {
    console.error('Product by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Purchase product endpoint
app.post('/purchase', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { product_id, quantity = 1 } = req.body;
    const userId = req.user.id;

    // Validate required fields
    if (!product_id || !quantity || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Product ID and valid quantity are required'
      });
    }

    // Get product details
    const [products] = await connection.execute(
      'SELECT id, title, price, stock, discount_percent FROM products WHERE id = ? AND isActive = 1',
      [product_id]
    );

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or inactive'
      });
    }

    const product = products[0];

    // Check if enough stock is available
    if (product.stock < quantity) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient stock available'
      });
    }

    // Get available product_stock (unsold items)
    const [availableStock] = await connection.execute(
      `SELECT id, license_key FROM product_stock WHERE product_id = ? AND sold = 0 LIMIT ${quantity}`,
      [product_id]
    );

    if (availableStock.length < quantity) {
      return res.status(400).json({
        success: false,
        message: 'สินค้าไม่พร้อมสำหรับซื้อ'
      });
    }

    // Get user's current money
    const [users] = await connection.execute(
      'SELECT money FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];
    
    // Calculate discounted price
    const originalPrice = parseFloat(product.price);
    const discountPercent = parseInt(product.discount_percent) || 0;
    const discountedPrice = originalPrice * (1 - discountPercent / 100);
    const totalPrice = discountedPrice * quantity;
    const totalDiscount = (originalPrice - discountedPrice) * quantity;

    // Check if user has enough money
    if (user.money < totalPrice) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
        required: totalPrice,
        available: user.money
      });
    }

    // Generate unique bill number
    const billNumber = `BILL-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Create transaction
    const [transactionResult] = await connection.execute(
      'INSERT INTO transactions (customer_id, bill_number, user_id, total_price) VALUES (?, ?, ?, ?)',
      [req.customer_id, billNumber, userId, totalPrice]
    );

    const transactionId = transactionResult.insertId;

    // Create transaction items and update product_stock
    const transactionItems = [];
    for (let i = 0; i < quantity; i++) {
      const stockItem = availableStock[i];
      
      // Create transaction item
      const [itemResult] = await connection.execute(
        'INSERT INTO transaction_items (customer_id, bill_number, transaction_id, product_id, quantity, price, license_id) VALUES (?, ?, ?, ?, 1, ?, ?)',
        [req.customer_id, billNumber, transactionId, product_id, discountedPrice, stockItem.id]
      );

      // Mark stock as sold
      await connection.execute(
        'UPDATE product_stock SET sold = 1 WHERE id = ?',
        [stockItem.id]
      );

      transactionItems.push({
        id: itemResult.insertId,
        license_key: stockItem.license_key
      });
    }

    // Deduct money from user
    await connection.execute(
      'UPDATE users SET money = money - ? WHERE id = ?',
      [totalPrice, userId]
    );

    // Update product stock count by counting unsold items
    const [stockCount] = await connection.execute(
      'SELECT COUNT(*) as available_stock FROM product_stock WHERE product_id = ? AND sold = 0',
      [product_id]
    );
    
    await connection.execute(
      'UPDATE products SET stock = ? WHERE id = ?',
      [stockCount[0].available_stock, product_id]
    );

    await connection.commit();

    // Get Discord webhook URL, site name, and site logo from config
    const [configRows] = await connection.execute(
      'SELECT discord_webhook, site_name, site_logo FROM config WHERE customer_id = ? ORDER BY id ASC LIMIT 1',
      [req.customer_id]
    );
    const discordWebhookUrl = configRows.length > 0 ? configRows[0].discord_webhook : null;
    const siteName = configRows.length > 0 ? configRows[0].site_name : 'Backend System';
    const siteLogo = configRows.length > 0 ? configRows[0].site_logo : 'https://img2.pic.in.th/pic/logodiscordf124e71a99293428.png';

    console.log("Discord webhook debug:", {
      hasConfig: configRows.length > 0,
      webhookUrl: discordWebhookUrl ? "SET" : "NOT_SET",
      webhookUrlLength: discordWebhookUrl ? discordWebhookUrl.length : 0
    });

    // Send Discord webhook if configured
    if (discordWebhookUrl) {
      try {
        const [userInfo] = await connection.execute(
          'SELECT fullname, email FROM users WHERE id = ?',
          [userId]
        );
        const user = userInfo[0];

        // Get user's remaining money after purchase
        const [remainingMoney] = await connection.execute(
          'SELECT money FROM users WHERE id = ?',
          [userId]
        );
        const newMoney = parseFloat(remainingMoney[0].money) || 0;

        const embed = {
          title: "🛒 การซื้อสินค้าใหม่",
          color: 0x00ff00,
          fields: [
            {
              name: "📋 หมายเลขบิล",
              value: billNumber,
              inline: true
            },
            {
              name: "👤 ผู้ซื้อ",
              value: user.fullname || user.email || "ไม่ระบุ",
              inline: true
            },
            {
              name: "💰 ราคารวม",
              value: `${totalPrice.toFixed(2)} บาท`,
              inline: true
            },
            {
              name: "📦 จำนวนสินค้า",
              value: `${transactionItems.length} รายการ`,
              inline: true
            },
            {
              name: "💳 เงินคงเหลือ",
              value: `${newMoney.toFixed(2)} บาท`,
              inline: true
            },
            {
              name: "🏷️ สินค้า",
              value: product.title,
              inline: false
            }
          ],
          timestamp: new Date().toISOString(),
          footer: {
            text: siteName
          },
          thumbnail: {
            url: siteLogo
          }
        };

        const webhookPayload = {
          embeds: [embed]
        };

        const webhookResponse = await axios.post(discordWebhookUrl, webhookPayload, {
          headers: {
            'Content-Type': 'application/json',
          }
        });

        console.log('Discord webhook sent successfully');
      } catch (webhookError) {
        console.error('Discord webhook error:', webhookError);
        // Don't fail the purchase if webhook fails
      }
    }

    res.json({
      success: true,
      message: 'Purchase completed successfully',
      transaction: {
        id: transactionId,
        bill_number: billNumber,
        total_price: totalPrice,
        items: transactionItems
      },
      product: {
        id: product.id,
        title: product.title,
        original_price: originalPrice,
        discounted_price: discountedPrice,
        discount_percent: discountPercent,
        total_discount: totalDiscount,
        quantity: quantity
      },
      summary: {
        subtotal: originalPrice * quantity,
        discount_applied: totalDiscount,
        total_paid: totalPrice
      }
    });

  } catch (error) {
    await connection.rollback();
    console.error('Purchase error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

// Get all products endpoint
app.get('/products', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const categoryId = req.query.category_id;
    let whereClause = 'p.customer_id = ? AND p.isActive = 1';
    let queryParams = [req.customer_id];

    // If category_id is provided, validate it and add to filter
    if (categoryId) {
      // Validate category ID
      if (isNaN(categoryId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid category ID format'
        });
      }

      // Check if category exists for this customer
      const [categoryCheck] = await pool.execute(
        'SELECT id, title FROM categories WHERE id = ? AND customer_id = ? AND isActive = 1',
        [categoryId, req.customer_id]
      );

      if (categoryCheck.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Category not found or inactive'
        });
      }

      // Add category filter to query
      whereClause += ' AND p.category_id = ?';
      queryParams.push(categoryId);
    }

    // Get products with category information for specific customer
    const [products] = await pool.execute(
      `SELECT 
        p.id, p.category_id, p.title, p.subtitle, p.price, p.reseller_price, p.stock, 
        p.duration, p.image, p.download_link, p.isSpecial, p.featured, p.isActive, 
        p.isWarrenty, p.warrenty_text, p.primary_color, p.secondary_color, 
        p.created_at, p.priority, p.discount_percent,
        c.title as category_title, c.category as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE ${whereClause}
      ORDER BY p.priority DESC, p.title ASC`,
      queryParams
    );

    // Calculate discounted prices for each product
    const productsWithDiscount = products.map(product => {
      const originalPrice = parseFloat(product.price);
      const discountPercent = parseInt(product.discount_percent) || 0;
      const discountedPrice = originalPrice * (1 - discountPercent / 100);
      
      return {
        ...product,
        original_price: originalPrice,
        discounted_price: discountedPrice,
        has_discount: discountPercent > 0,
        discount_savings: originalPrice - discountedPrice
      };
    });

    res.json({
      success: true,
      message: 'Products retrieved successfully',
      products: productsWithDiscount,
      total: productsWithDiscount.length,
      category_id: categoryId || null
    });

  } catch (error) {
    console.error('Products error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get user's transactions endpoint
app.get('/my-transactions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's transactions with transaction items
    const [transactions] = await pool.execute(
      `SELECT 
        t.id, t.bill_number, t.total_price, t.created_at,
        ti.id as item_id, ti.product_id, ti.quantity, ti.price as item_price,
        ti.license_id, ps.license_key,
        p.title as product_title, p.image as product_image
      FROM transactions t
      LEFT JOIN transaction_items ti ON t.id = ti.transaction_id
      LEFT JOIN product_stock ps ON ti.license_id = ps.id
      LEFT JOIN products p ON ti.product_id = p.id
      WHERE t.user_id = ?
      ORDER BY t.created_at DESC, ti.id ASC`,
      [userId]
    );

    // Group transactions and their items
    const transactionMap = new Map();
    
    transactions.forEach(row => {
      if (!transactionMap.has(row.id)) {
        transactionMap.set(row.id, {
          id: row.id,
          bill_number: row.bill_number,
          total_price: row.total_price,
          created_at: row.created_at,
          items: []
        });
      }
      
      if (row.item_id) {
        transactionMap.get(row.id).items.push({
          id: row.item_id,
          product_id: row.product_id,
          product_title: row.product_title,
          product_image: row.product_image,
          quantity: row.quantity,
          price: row.item_price,
          license_key: row.license_key
        });
      }
    });

    const userTransactions = Array.from(transactionMap.values());

    res.json({
      success: true,
      message: 'Transactions retrieved successfully',
      transactions: userTransactions,
      total: userTransactions.length
    });

  } catch (error) {
    console.error('My transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get user role permissions endpoint
app.get('/myrole', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's role and role permissions
    const [userRoles] = await pool.execute(
      `SELECT 
        u.id, u.fullname, u.email, u.role,
        r.id as role_id, r.rank_name, 
        r.can_edit_categories, r.can_edit_products, r.can_edit_users, 
        r.can_edit_orders, r.can_manage_keys, r.can_view_reports, 
        r.can_manage_promotions, r.can_manage_settings, r.can_access_reseller_price
      FROM users u
      LEFT JOIN roles r ON u.role = r.rank_name
      WHERE u.id = ?`,
      [userId]
    );

    if (userRoles.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userRole = userRoles[0];

    // If no role found in roles table, return default member permissions
    if (!userRole.role_id) {
      return res.json({
        success: true,
        message: 'User role permissions retrieved successfully',
        user: {
          id: userRole.id,
          fullname: userRole.fullname,
          email: userRole.email,
          role: userRole.role || 'member'
        },
        permissions: {
          can_edit_categories: false,
          can_edit_products: false,
          can_edit_users: false,
          can_edit_orders: false,
          can_manage_keys: false,
          can_view_reports: false,
          can_manage_promotions: false,
          can_manage_settings: false,
          can_access_reseller_price: false
        },
        role_info: {
          id: null,
          rank_name: userRole.role || 'member',
          description: 'Default member role with basic permissions'
        }
      });
    }

    // Return role permissions
    res.json({
      success: true,
      message: 'User role permissions retrieved successfully',
      user: {
        id: userRole.id,
        fullname: userRole.fullname,
        email: userRole.email,
        role: userRole.role
      },
      permissions: {
        can_edit_categories: Boolean(userRole.can_edit_categories),
        can_edit_products: Boolean(userRole.can_edit_products),
        can_edit_users: Boolean(userRole.can_edit_users),
        can_edit_orders: Boolean(userRole.can_edit_orders),
        can_manage_keys: Boolean(userRole.can_manage_keys),
        can_view_reports: Boolean(userRole.can_view_reports),
        can_manage_promotions: Boolean(userRole.can_manage_promotions),
        can_manage_settings: Boolean(userRole.can_manage_settings),
        can_access_reseller_price: Boolean(userRole.can_access_reseller_price)
      },
      role_info: {
        id: userRole.role_id,
        rank_name: userRole.rank_name,
        description: `Role: ${userRole.rank_name} with specific permissions`
      }
    });

  } catch (error) {
    console.error('My role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get all roles endpoint (admin only)
app.get('/roles', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const [roles] = await pool.execute(
      'SELECT * FROM roles WHERE customer_id = ? ORDER BY id ASC',
      [req.customer_id]
    );

    res.json({
      success: true,
      message: 'Roles retrieved successfully',
      roles: roles
    });

  } catch (error) {
    console.error('Roles error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update user role endpoint (admin only)
app.put('/users/:userId/role', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    // Validate required fields
    if (!role) {
      return res.status(400).json({
        success: false,
        message: 'Role is required'
      });
    }

    // Check if role exists
    const [roleCheck] = await pool.execute(
      'SELECT id FROM roles WHERE rank_name = ?',
      [role]
    );

    if (roleCheck.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Available roles: member, moderator, admin, super_admin, reseller'
      });
    }

    // Check if user exists
    const [userCheck] = await pool.execute(
      'SELECT id, fullname, email FROM users WHERE id = ?',
      [userId]
    );

    if (userCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user role
    await pool.execute(
      'UPDATE users SET role = ? WHERE id = ?',
      [role, userId]
    );

    res.json({
      success: true,
      message: 'User role updated successfully',
      user: {
        id: userCheck[0].id,
        fullname: userCheck[0].fullname,
        email: userCheck[0].email,
        role: role
      }
    });

  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Example protected endpoint that requires specific permission
app.get('/admin/dashboard', authenticateToken, requirePermission('can_view_reports'), async (req, res) => {
  try {
    // This endpoint is only accessible to users with can_view_reports permission
    const [stats] = await pool.execute(
      `SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM products) as total_products,
        (SELECT COUNT(*) FROM transactions) as total_transactions,
        (SELECT SUM(total_price) FROM transactions) as total_revenue`
    );

    res.json({
      success: true,
      message: 'Admin dashboard data retrieved successfully',
      dashboard: {
        total_users: stats[0].total_users,
        total_products: stats[0].total_products,
        total_transactions: stats[0].total_transactions,
        total_revenue: stats[0].total_revenue || 0
      }
    });

  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get statistics endpoint
app.get('/get-stats', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    console.log('Fetching stats for customer_id:', req.customer_id);

    // Check database connection status
    let dbStatus = '24/7';
    let dbMessage = 'Database is running normally';
    
    try {
      // Test database connection
      await pool.execute('SELECT 1');
    } catch (dbError) {
      dbStatus = 'อยู่ระหว่างปรับปรุง';
      dbMessage = 'Database connection failed';
      console.error('Database connection error:', dbError);
    }

    // Get total users count for specific customer
    const [userCountResult] = await pool.execute(
      'SELECT COUNT(*) as total_users FROM users WHERE customer_id = ?',
      [req.customer_id]
    );
    const totalUsers = userCountResult[0].total_users;
    console.log('Total users:', totalUsers);

    // Get total sold items count (from transaction_items) for specific customer
    const [soldItemsResult] = await pool.execute(
      'SELECT COUNT(*) as total_sold FROM transaction_items WHERE customer_id = ?',
      [req.customer_id]
    );
    const totalSoldItems = soldItemsResult[0].total_sold;
    console.log('Total sold items:', totalSoldItems);

    // Get unsold product stock count for specific customer
    const [unsoldStockResult] = await pool.execute(
      'SELECT COUNT(*) as total_unsold FROM product_stock WHERE customer_id = ? AND sold = 0',
      [req.customer_id]
    );
    const totalUnsoldStock = unsoldStockResult[0].total_unsold;
    console.log('Total unsold stock:', totalUnsoldStock);

    // Get total products count for debugging
    const [productsResult] = await pool.execute(
      'SELECT COUNT(*) as total_products FROM products WHERE customer_id = ?',
      [req.customer_id]
    );
    const totalProducts = productsResult[0].total_products;
    console.log('Total products:', totalProducts);

    // Get total licenses count (both sold and unsold) for debugging
    const [licensesResult] = await pool.execute(
      'SELECT COUNT(*) as total_licenses, SUM(CASE WHEN sold = 0 THEN 1 ELSE 0 END) as unsold_licenses, SUM(CASE WHEN sold = 1 THEN 1 ELSE 0 END) as sold_licenses FROM product_stock WHERE customer_id = ?',
      [req.customer_id]
    );
    const licensesStats = licensesResult[0];
    console.log('Licenses stats:', licensesStats);

    res.json({
      success: true,
      message: 'Statistics retrieved successfully',
      debug: {
        customer_id: req.customer_id,
        total_products: totalProducts,
        licenses: licensesStats
      },
      stats: {
        users: {
          total_users: totalUsers
        },
        products: {
          total_products: totalProducts
        },
        stock: {
          total_licenses: parseInt(licensesStats.total_licenses) || 0,
          sold_licenses: parseInt(licensesStats.sold_licenses) || 0,
          unsold_licenses: parseInt(licensesStats.unsold_licenses) || 0
        },
        transactions: {
          total_sold_items: totalSoldItems
        },
        database_status: {
          status: dbStatus,
          message: dbMessage,
          timestamp: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
      stats: {
        users: { total_users: 0 },
        products: { total_products: 0 },
        stock: { 
          total_licenses: 0,
          sold_licenses: 0,
          unsold_licenses: 0
        },
        transactions: { total_sold_items: 0 },
        database_status: {
          status: 'อยู่ระหว่างปรับปรุง',
          message: 'Unable to retrieve statistics',
          timestamp: new Date().toISOString()
        }
      }
    });
  }
});

// Get expired day endpoint
app.get('/getexpiredday', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    // Get expired day from auth_sites table for this customer
    const [sites] = await pool.execute(
      'SELECT expiredDay FROM auth_sites WHERE customer_id = ? ORDER BY id ASC LIMIT 1',
      [req.customer_id]
    );

    if (sites.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลวันหมดอายุสำหรับลูกค้านี้'
      });
    }

    const expiredDay = sites[0].expiredDay;

    res.json({
      success: true,
      message: 'ดึงข้อมูลวันหมดอายุสำเร็จ',
      expiredDay: expiredDay,
      customer_id: req.customer_id
    });

  } catch (error) {
    console.error('Get expired day error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Check customer status and expiry endpoint
app.get('/check-customer-status', async (req, res) => {
  try {
    // Check if customer_id is available from multitenant middleware
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'ไม่มีข้อมูล customer_id',
        status: 'no_customer_id'
      });
    }

    // Get customer info and status from auth_sites table
    const [sites] = await pool.execute(
      'SELECT customer_id, website_name, expiredDay, status FROM auth_sites WHERE customer_id = ? ORDER BY id ASC LIMIT 1',
      [req.customer_id]
    );

    if (sites.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูล customer_id',
        status: 'customer_not_found'
      });
    }

    const site = sites[0];
    const currentDate = new Date();
    
    // Return status directly from database
    return res.json({
      success: true,
      message: site.status === 'active' ? 'ยังไม่หมดอายุ' : 'หมดอายุ',
      status: site.status,
      customer_id: req.customer_id,
      website_name: site.website_name,
      expiredDay: site.expiredDay,
      currentDate: currentDate.toISOString().split('T')[0]
    });

  } catch (error) {
    console.error('Check customer status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Redeem angpao endpoint
app.post('/redeem-angpao', authenticateToken, async (req, res) => {
  try {
    // Check if customer_id matches token
    if (req.user.customer_id !== req.customer_id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied - customer mismatch'
      });
    }

    const { link } = req.body;

    if (!link) {
      return res.status(400).json({ success: false, error: 'กรุณาระบุ link' });
    }

    // ดึงเบอร์โทรจากตาราง config สำหรับ customer นี้
    const [configRows] = await pool.execute(
      'SELECT owner_phone FROM config WHERE customer_id = ? ORDER BY id ASC LIMIT 1',
      [req.customer_id]
    );
    
    if (!configRows.length) {
      return res.status(400).json({ success: false, error: 'ไม่พบเบอร์โทรในตาราง config' });
    }

    const phone = configRows[0].owner_phone;

    // ดึงข้อมูลผู้ใช้ปัจจุบัน
    const [user] = await pool.execute(
      "SELECT id, money FROM users WHERE id = ? AND customer_id = ?",
      [req.user.id, req.customer_id]
    );
    
    if (user.length === 0) {
      return res.status(404).json({ success: false, error: 'ไม่พบผู้ใช้' });
    }

    // ดึง campaign ID จาก link
    let campaignId = link;

    if (link.includes('gift.truemoney.com/campaign/?v=')) {
      const urlParams = new URL(link).searchParams;
      campaignId = urlParams.get('v');
    } else if (link.includes('v=')) {
      const match = link.match(/[?&]v=([^&]+)/);
      if (match) {
        campaignId = match[1];
      }
    }

    if (!campaignId) {
      return res.status(400).json({ success: false, error: 'ไม่พบ campaign ID ในลิงก์' });
    }

    // เรียก API TrueMoney พร้อม retry
    let data;
    let lastError;
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Calling TrueMoney API (attempt ${attempt}/${maxRetries}): https://api.xpluem.com/${campaignId}/${phone}`);
        
        const response = await axios.get(`https://api.xpluem.com/${campaignId}/${phone}`, {
          timeout: 15000, // เพิ่ม timeout เป็น 15 วินาที
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Cache-Control': 'no-cache'
          },
          validateStatus: function (status) {
            return status < 500; // รับ status code น้อยกว่า 500
          }
        });
        
        data = response.data;
        console.log(`TrueMoney API Response (attempt ${attempt}):`, data);
        
        // ถ้าได้ response แล้วให้ break ออกจาก loop
        break;
        
      } catch (error) {
        lastError = error;
        console.error(`TrueMoney API attempt ${attempt} failed:`, error.message);
        
        // ถ้าเป็น attempt สุดท้ายให้ throw error
        if (attempt === maxRetries) {
          throw error;
        }
        
        // รอ 2 วินาทีก่อนลองใหม่
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // เริ่ม transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // ตรวจสอบ response data
      if (!data) {
        throw new Error('ไม่ได้รับข้อมูลจาก API');
      }

      const amount = data.data ? parseFloat(data.data.amount) : 0;
      const status = data.success ? 'success' : 'failed';
      
      // ตรวจสอบจำนวนเงิน
      if (amount <= 0) {
        throw new Error('จำนวนเงินไม่ถูกต้อง');
      }

      // ตรวจสอบว่ามีการเติมเงินซ้ำหรือไม่ (ตรวจสอบ campaign ID ใน 24 ชั่วโมงที่ผ่านมา)
      const [existingTopup] = await connection.execute(
        'SELECT id FROM topups WHERE user_id = ? AND customer_id = ? AND transaction_ref = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)',
        [req.user.id, req.customer_id, `Campaign: ${campaignId}`]
      );

      if (existingTopup.length > 0) {
        throw new Error('ลิงก์นี้ถูกใช้แล้วใน 24 ชั่วโมงที่ผ่านมา');
      }

      // บันทึกลงตาราง topups
      const [topupResult] = await connection.execute(
        'INSERT INTO topups (customer_id, user_id, amount, method, transaction_ref, status) VALUES (?, ?, ?, ?, ?, ?)',
        [req.customer_id, req.user.id, amount, 'gift_card', `Campaign: ${campaignId}`, status]
      );

      // ถ้าสำเร็จ ให้บวกเงิน
      if (data.success && (data.message === 'รับเงินสำเร็จ' || data.message === 'success')) {
        const newMoney = parseFloat(user[0].money) + amount;
        
        // อัปเดตเงินผู้ใช้
        const [updateResult] = await connection.execute(
          'UPDATE users SET money = ? WHERE id = ? AND customer_id = ?',
          [newMoney, req.user.id, req.customer_id]
        );

        if (updateResult.affectedRows === 0) {
          throw new Error('ไม่สามารถอัปเดตเงินผู้ใช้ได้');
        }

        // อัปเดตสถานะ topup เป็น success
        await connection.execute(
          'UPDATE topups SET status = ? WHERE id = ?',
          ['success', topupResult.insertId]
        );

        await connection.commit();

        console.log(`Topup successful: Customer ${req.customer_id}, User ${req.user.id}, Amount: ${amount}, New Balance: ${newMoney}`);

        res.json({
          success: true,
          message: `เติมเงินสำเร็จ: +${amount} บาท`,
          amount: amount,
          new_balance: newMoney,
          topup_id: topupResult.insertId,
          campaign_id: campaignId
        });
      } else {
        // อัปเดตสถานะ topup เป็น failed
        await connection.execute(
          'UPDATE topups SET status = ? WHERE id = ?',
          ['failed', topupResult.insertId]
        );

        await connection.commit();

        console.log(`Topup failed: Customer ${req.customer_id}, User ${req.user.id}, Campaign: ${campaignId}, Message: ${data.message}`);

        res.json({
          success: false,
          message: data.message || 'การเติมเงินไม่สำเร็จ',
          amount: amount,
          topup_id: topupResult.insertId,
          campaign_id: campaignId
        });
      }

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

  } catch (err) {
    console.error('Redeem angpao error:', err);

    // กรณีเรียก API ล้มเหลว
    if (err.response) {
      console.error('API Error Details:', {
        status: err.response.status,
        statusText: err.response.statusText,
        data: err.response.data,
        url: err.config?.url,
        user_id: req.user?.id,
        customer_id: req.customer_id,
        campaign_id: campaignId
      });

      let errorMessage = 'ไม่สามารถเชื่อมต่อ API ได้';

      if (err.response.status === 500) {
        errorMessage = 'API เกิดข้อผิดพลาดภายใน (500) - อาจเป็นเพราะ campaign ID ไม่ถูกต้องหรือ API มีปัญหา';
      } else if (err.response.status === 404) {
        errorMessage = 'ไม่พบ campaign ID ที่ระบุ - ลิงก์อาจหมดอายุหรือไม่ถูกต้อง';
      } else if (err.response.status === 400) {
        errorMessage = 'ข้อมูลที่ส่งไปไม่ถูกต้อง - ตรวจสอบลิงก์และเบอร์โทร';
      } else if (err.response.status === 403) {
        errorMessage = 'ไม่มีสิทธิ์เข้าถึง API - ลิงก์อาจถูกใช้แล้ว';
      } else if (err.response.status === 429) {
        errorMessage = 'เรียก API เกินขีดจำกัด - กรุณารอสักครู่แล้วลองใหม่';
      }

      return res.status(500).json({
        success: false,
        error: errorMessage,
        details: {
          status: err.response.status,
          message: err.response.data?.message || err.response.statusText,
          campaign_id: campaignId
        }
      });
    }

    // กรณี timeout หรือ network error
    if (err.code === 'ECONNABORTED') {
      return res.status(500).json({
        success: false,
        error: 'การเชื่อมต่อ API หมดเวลา - กรุณาลองใหม่อีกครั้ง',
        details: {
          code: err.code,
          campaign_id: campaignId
        }
      });
    }

    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return res.status(500).json({
        success: false,
        error: 'ไม่สามารถเชื่อมต่อ API ได้ - ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต',
        details: {
          code: err.code,
          campaign_id: campaignId
        }
      });
    }

    // กรณี error อื่นๆ
    res.status(500).json({
      success: false,
      error: err.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ',
      details: {
        message: err.message,
        campaign_id: campaignId,
        user_id: req.user?.id,
        customer_id: req.customer_id
      }
    });
  }
});






// ==================== PRODUCT MANAGEMENT API ====================

// Get all products for admin (including inactive ones)
app.get('/admin/products', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const { 
      includeInactive = false, 
      categoryId = null,
      page = 1,
      limit = 50,
      search = '',
      sortBy = 'priority',
      sortOrder = 'desc'
    } = req.query;

    // Parse and validate pagination parameters
    const parsedPage = parseInt(page, 10) || 1;
    const parsedLimit = parseInt(limit, 10) || 50;

    // Build base query
    let query = `
      SELECT 
        p.id, p.category_id, p.title, p.subtitle, p.price, p.reseller_price, 
        p.stock, p.duration, p.image, p.download_link, p.isSpecial, p.featured, 
        p.isActive, p.isWarrenty, p.warrenty_text, p.primary_color, p.secondary_color, 
        p.created_at, p.priority, p.discount_percent, p.customer_id,
        c.title as category_title, c.category as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.customer_id = ?
    `;

    const queryParams = [req.customer_id];

    // Add filters
    if (!includeInactive || includeInactive === 'false') {
      query += ' AND p.isActive = 1';
    }

    if (categoryId && !isNaN(categoryId)) {
      // Validate that category exists for this customer
      const [categoryCheck] = await pool.execute(
        'SELECT id, title FROM categories WHERE id = ? AND customer_id = ? AND isActive = 1',
        [parseInt(categoryId), req.customer_id]
      );

      if (categoryCheck.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Category not found or inactive'
        });
      }

      query += ' AND p.category_id = ?';
      queryParams.push(parseInt(categoryId));
    }

    if (search && search.trim() !== '') {
      query += ' AND (p.title LIKE ? OR p.subtitle LIKE ? OR c.title LIKE ?)';
      const searchPattern = `%${search.trim()}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern);
    }

    // Add sorting
    const validSortFields = ['priority', 'title', 'price', 'stock', 'created_at', 'category_title'];
    const validSortOrders = ['asc', 'desc'];
    
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'priority';
    const sortDirection = validSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toUpperCase() : 'DESC';
    
    if (sortField === 'category_title') {
      query += ` ORDER BY c.title ${sortDirection}, p.title ASC`;
    } else {
      query += ` ORDER BY p.${sortField} ${sortDirection}, p.title ASC`;
    }

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(*) as total
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.customer_id = ?
    `;
    const countParams = [req.customer_id];

    if (!includeInactive || includeInactive === 'false') {
      countQuery += ' AND p.isActive = 1';
    }

    if (categoryId && !isNaN(categoryId)) {
      countQuery += ' AND p.category_id = ?';
      countParams.push(parseInt(categoryId));
    }

    if (search && search.trim() !== '') {
      countQuery += ' AND (p.title LIKE ? OR p.subtitle LIKE ? OR c.title LIKE ?)';
      const searchPattern = `%${search.trim()}%`;
      countParams.push(searchPattern, searchPattern, searchPattern);
    }

    // Add pagination
    if (parsedLimit && parsedLimit > 0) {
      const offset = (parsedPage - 1) * parsedLimit;
      query += ` LIMIT ${parsedLimit} OFFSET ${offset}`;
      // Note: Using direct substitution instead of placeholders for LIMIT/OFFSET
      // because some MySQL2 versions have issues with prepared statements + LIMIT/OFFSET
    }

    // Debug logging
    console.log('Admin Products Query Debug:', {
      customer_id: req.customer_id,
      queryParams: queryParams,
      countParams: countParams,
      query: query,
      countQuery: countQuery,
      query_placeholders: (query.match(/\?/g) || []).length,
      countQuery_placeholders: (countQuery.match(/\?/g) || []).length
    });

    // Execute queries
    const [products] = await pool.execute(query, queryParams);
    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      success: true,
      message: 'Products retrieved successfully',
      products: products,
      total: total,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(total / parsedLimit),
      filters: {
        includeInactive: includeInactive === 'true',
        categoryId: categoryId ? parseInt(categoryId) : null,
        search: search,
        sortBy: sortField,
        sortOrder: sortDirection.toLowerCase()
      }
    });

  } catch (error) {
    console.error('Admin products error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get single product for admin
app.get('/admin/products/:productId', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { productId } = req.params;

    // Validate product ID
    if (!productId || isNaN(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid product ID is required'
      });
    }

    // Get product details
    const [products] = await pool.execute(
      `SELECT 
        p.id, p.category_id, p.title, p.subtitle, p.price, p.reseller_price, 
        p.stock, p.duration, p.image, p.download_link, p.isSpecial, p.featured, 
        p.isActive, p.isWarrenty, p.warrenty_text, p.primary_color, p.secondary_color, 
        p.created_at, p.priority, p.discount_percent, p.customer_id,
        c.title as category_title, c.category as category_slug, c.parent_id as category_parent_id
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ? AND p.customer_id = ?`,
      [productId, req.customer_id]
    );

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const product = products[0];

    // Get category hierarchy if category exists
    if (product.category_id) {
      const categoryHierarchy = [];
      let currentCategoryId = product.category_id;

      // Build category hierarchy (breadcrumb)
      while (currentCategoryId) {
        const [categoryInfo] = await pool.execute(
          'SELECT id, title, parent_id FROM categories WHERE id = ? AND customer_id = ?',
          [currentCategoryId, req.customer_id]
        );

        if (categoryInfo.length > 0) {
          categoryHierarchy.unshift(categoryInfo[0]);
          currentCategoryId = categoryInfo[0].parent_id;
        } else {
          break;
        }
      }

      product.category_hierarchy = categoryHierarchy;
    }

    res.json({
      success: true,
      message: 'Product retrieved successfully',
      product: product
    });

  } catch (error) {
    console.error('Admin product detail error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get products by category for admin
app.get('/admin/categories/:categoryId/products', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { 
      includeInactive = false, 
      page = 1,
      limit = 50 
    } = req.query;

    // Validate category ID
    if (!categoryId || isNaN(categoryId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid category ID is required'
      });
    }

    // Check if category exists for this customer
    const [categoryCheck] = await pool.execute(
      'SELECT id, title FROM categories WHERE id = ? AND customer_id = ?',
      [categoryId, req.customer_id]
    );

    if (categoryCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Build query
    let query = `
      SELECT 
        p.id, p.category_id, p.title, p.subtitle, p.price, p.reseller_price, 
        p.stock, p.duration, p.image, p.download_link, p.isSpecial, p.featured, 
        p.isActive, p.isWarrenty, p.warrenty_text, p.primary_color, p.secondary_color, 
        p.created_at, p.priority, p.discount_percent,
        c.title as category_title, c.category as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.category_id = ? AND p.customer_id = ?
    `;

    const queryParams = [categoryId, req.customer_id];

    if (!includeInactive || includeInactive === 'false') {
      query += ' AND p.isActive = 1';
    }

    query += ' ORDER BY p.priority DESC, p.title ASC';

    // Add pagination
    if (limit && !isNaN(limit)) {
      const parsedLimitLocal = parseInt(limit, 10);
      const parsedPageLocal = parseInt(page, 10) || 1;
      const offset = (parsedPageLocal - 1) * parsedLimitLocal;
      query += ` LIMIT ${parsedLimitLocal} OFFSET ${offset}`;
    }

    // Get products
    const [products] = await pool.execute(query, queryParams);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM products WHERE category_id = ? AND customer_id = ?';
    const countParams = [categoryId, req.customer_id];

    if (!includeInactive || includeInactive === 'false') {
      countQuery += ' AND isActive = 1';
    }

    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      success: true,
      message: 'Products retrieved successfully',
      category: categoryCheck[0],
      products: products,
      total: total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit))
    });

  } catch (error) {
    console.error('Admin category products error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Create new product endpoint
app.post('/admin/products', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const {
      category_id,
      title,
      subtitle,
      price,
      reseller_price,
      stock,
      duration,
      image,
      download_link,
      isSpecial,
      featured,
      isWarrenty,
      warrenty_text,
      primary_color,
      secondary_color,
      priority,
      discount_percent
    } = req.body;

    // Validate required fields
    if (!category_id || !title || !price) {
      return res.status(400).json({
        success: false,
        message: 'Category ID, title, and price are required'
      });
    }

    // Check if category exists for this customer
    const [categoryCheck] = await pool.execute(
      'SELECT id FROM categories WHERE id = ? AND customer_id = ? AND isActive = 1',
      [category_id, req.customer_id]
    );

    if (categoryCheck.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Category not found or inactive'
      });
    }

    // Insert new product
    const [result] = await pool.execute(
      `INSERT INTO products (
        customer_id, category_id, title, subtitle, price, reseller_price, 
        stock, duration, image, download_link, isSpecial, featured, 
        isWarrenty, warrenty_text, primary_color, secondary_color, 
        priority, discount_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.customer_id, category_id, title, subtitle || null, price, 
        reseller_price || null, stock || 0, duration || null, image || null, 
        download_link || null, isSpecial || 0, featured || 0, isWarrenty || 0, 
        warrenty_text || null, primary_color || null, secondary_color || null, 
        priority || 0, discount_percent || 0
      ]
    );

    // Get the created product
    const [newProduct] = await pool.execute(
      'SELECT * FROM products WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      product: newProduct[0]
    });

  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update product endpoint
app.put('/admin/products/:productId', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { productId } = req.params;
    const {
      category_id,
      title,
      subtitle,
      price,
      reseller_price,
      stock,
      duration,
      image,
      download_link,
      isSpecial,
      featured,
      isWarrenty,
      warrenty_text,
      primary_color,
      secondary_color,
      priority,
      discount_percent,
      isActive
    } = req.body;

    // Validate product ID
    if (!productId || isNaN(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid product ID is required'
      });
    }

    // Check if product exists for this customer
    const [productCheck] = await pool.execute(
      'SELECT id FROM products WHERE id = ? AND customer_id = ?',
      [productId, req.customer_id]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // If category_id is provided, check if it exists
    if (category_id) {
      const [categoryCheck] = await pool.execute(
        'SELECT id FROM categories WHERE id = ? AND customer_id = ? AND isActive = 1',
        [category_id, req.customer_id]
      );

      if (categoryCheck.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Category not found or inactive'
        });
      }
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (category_id !== undefined) {
      updateFields.push('category_id = ?');
      updateValues.push(category_id);
    }
    if (title !== undefined) {
      updateFields.push('title = ?');
      updateValues.push(title);
    }
    if (subtitle !== undefined) {
      updateFields.push('subtitle = ?');
      updateValues.push(subtitle);
    }
    if (price !== undefined) {
      updateFields.push('price = ?');
      updateValues.push(price);
    }
    if (reseller_price !== undefined) {
      updateFields.push('reseller_price = ?');
      updateValues.push(reseller_price);
    }
    if (stock !== undefined) {
      updateFields.push('stock = ?');
      updateValues.push(stock);
    }
    if (duration !== undefined) {
      updateFields.push('duration = ?');
      updateValues.push(duration);
    }
    if (image !== undefined) {
      updateFields.push('image = ?');
      updateValues.push(image);
    }
    if (download_link !== undefined) {
      updateFields.push('download_link = ?');
      updateValues.push(download_link);
    }
    if (isSpecial !== undefined) {
      updateFields.push('isSpecial = ?');
      updateValues.push(isSpecial);
    }
    if (featured !== undefined) {
      updateFields.push('featured = ?');
      updateValues.push(featured);
    }
    if (isWarrenty !== undefined) {
      updateFields.push('isWarrenty = ?');
      updateValues.push(isWarrenty);
    }
    if (warrenty_text !== undefined) {
      updateFields.push('warrenty_text = ?');
      updateValues.push(warrenty_text);
    }
    if (primary_color !== undefined) {
      updateFields.push('primary_color = ?');
      updateValues.push(primary_color);
    }
    if (secondary_color !== undefined) {
      updateFields.push('secondary_color = ?');
      updateValues.push(secondary_color);
    }
    if (priority !== undefined) {
      updateFields.push('priority = ?');
      updateValues.push(priority);
    }
    if (discount_percent !== undefined) {
      updateFields.push('discount_percent = ?');
      updateValues.push(discount_percent);
    }
    if (isActive !== undefined) {
      updateFields.push('isActive = ?');
      updateValues.push(isActive);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    updateValues.push(productId);

    // Update product
    await pool.execute(
      `UPDATE products SET ${updateFields.join(', ')} WHERE id = ? AND customer_id = ?`,
      [...updateValues, req.customer_id]
    );

    // Get updated product
    const [updatedProduct] = await pool.execute(
      'SELECT * FROM products WHERE id = ? AND customer_id = ?',
      [productId, req.customer_id]
    );

    res.json({
      success: true,
      message: 'Product updated successfully',
      product: updatedProduct[0]
    });

  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Delete product endpoint (force delete with all related data)
app.delete('/admin/products/:productId', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { productId } = req.params;
    const { force = false } = req.query;

    // Validate product ID
    if (!productId || isNaN(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid product ID is required'
      });
    }

    // Check if product exists for this customer
    const [productCheck] = await pool.execute(
      'SELECT id, title FROM products WHERE id = ? AND customer_id = ?',
      [productId, req.customer_id]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (force === 'true' || force === true) {
      // Force delete - remove all related data first
      await deleteProductWithRelatedData(productId, req.customer_id);
      
      res.json({
        success: true,
        message: 'Product and all related data deleted successfully (force delete)',
        product: {
          id: productCheck[0].id,
          title: productCheck[0].title
        }
      });
    } else {
      // Normal delete with checks
      // Check if product has stock
      const [stockCheck] = await pool.execute(
        'SELECT COUNT(*) as count FROM product_stock WHERE product_id = ? AND customer_id = ?',
        [productId, req.customer_id]
      );

      if (stockCheck[0].count > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete product with stock. Use ?force=true to force delete or remove stock first.',
          stock_count: stockCheck[0].count
        });
      }

      // Normal delete (no stock)
      await pool.execute(
        'DELETE FROM products WHERE id = ? AND customer_id = ?',
        [productId, req.customer_id]
      );

      res.json({
        success: true,
        message: 'Product deleted successfully',
        product: {
          id: productCheck[0].id,
          title: productCheck[0].title
        }
      });
    }

  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Helper function to delete product with all related data
async function deleteProductWithRelatedData(productId, customerId) {
  try {
    // Get all product_stock IDs for this product
    const [productStocks] = await pool.execute(
      'SELECT id FROM product_stock WHERE product_id = ? AND customer_id = ?',
      [productId, customerId]
    );

    // Delete transaction_items that reference these product_stock entries
    for (const stock of productStocks) {
      await pool.execute(
        'DELETE FROM transaction_items WHERE license_id = ?',
        [stock.id]
      );
    }

    // Now we can safely delete product_stock
    await pool.execute(
      'DELETE FROM product_stock WHERE product_id = ? AND customer_id = ?',
      [productId, customerId]
    );

    // Finally, delete the product itself
    await pool.execute(
      'DELETE FROM products WHERE id = ? AND customer_id = ?',
      [productId, customerId]
    );

  } catch (error) {
    console.error('Error in deleteProductWithRelatedData:', error);
    throw error;
  }
}

// ==================== CATEGORY MANAGEMENT API ====================

// Get all categories for admin (including inactive ones)
app.get('/admin/categories', authenticateToken, requirePermission('can_edit_categories'), async (req, res) => {
  try {
    const { 
      includeInactive = false, 
      flat = false,
      page = 1,
      limit = 50 
    } = req.query;

    // Build query based on includeInactive parameter
    let query = `
      SELECT 
        id, parent_id, title, subtitle, image, category, featured, 
        isActive, priority, created_at, customer_id
      FROM categories 
      WHERE customer_id = ?
    `;
    
    if (!includeInactive || includeInactive === 'false') {
      query += ' AND isActive = 1';
    }
    
    query += ' ORDER BY priority DESC, title ASC';

    // Add pagination if not flat structure
    const queryParams = [req.customer_id];
    if (flat === 'true' && limit && !isNaN(limit)) {
      const offset = (parseInt(page) - 1) * parseInt(limit);
      query += ' LIMIT ? OFFSET ?';
      queryParams.push(parseInt(limit), parseInt(offset));
    }

    const [categories] = await pool.execute(query, queryParams);

    // If flat structure requested, return simple array
    if (flat === 'true') {
      // Get total count for pagination
      let countQuery = 'SELECT COUNT(*) as total FROM categories WHERE customer_id = ?';
      const countParams = [req.customer_id];
      if (!includeInactive || includeInactive === 'false') {
        countQuery += ' AND isActive = 1';
      }
      
      const [countResult] = await pool.execute(countQuery, countParams);
      const total = countResult[0].total;

      return res.json({
        success: true,
        message: 'Categories retrieved successfully',
        categories: categories,
        total: total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      });
    }

    // Build hierarchical structure
    const categoryMap = new Map();
    const rootCategories = [];

    // First pass: create map of all categories
    categories.forEach(category => {
      categoryMap.set(category.id, {
        ...category,
        children: []
      });
    });

    // Second pass: build hierarchy
    categories.forEach(category => {
      const categoryObj = categoryMap.get(category.id);
      
      if (category.parent_id === null) {
        // Root category
        rootCategories.push(categoryObj);
      } else {
        // Child category
        const parent = categoryMap.get(category.parent_id);
        if (parent) {
          parent.children.push(categoryObj);
        }
      }
    });

    res.json({
      success: true,
      message: 'Categories retrieved successfully',
      categories: rootCategories,
      total: categories.length
    });

  } catch (error) {
    console.error('Admin categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get single category for admin
app.get('/admin/categories/:categoryId', authenticateToken, requirePermission('can_edit_categories'), async (req, res) => {
  try {
    const { categoryId } = req.params;

    // Validate category ID
    if (!categoryId || isNaN(categoryId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid category ID is required'
      });
    }

    // Get category details
    const [categories] = await pool.execute(
      `SELECT 
        id, parent_id, title, subtitle, image, category, featured, 
        isActive, priority, created_at, customer_id
      FROM categories 
      WHERE id = ? AND customer_id = ?`,
      [categoryId, req.customer_id]
    );

    if (categories.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const category = categories[0];

    // Get parent category info if exists
    if (category.parent_id) {
      const [parentCategory] = await pool.execute(
        'SELECT id, title FROM categories WHERE id = ? AND customer_id = ?',
        [category.parent_id, req.customer_id]
      );
      
      if (parentCategory.length > 0) {
        category.parent_info = parentCategory[0];
      }
    }

    // Get child categories
    const [childCategories] = await pool.execute(
      'SELECT id, title, isActive FROM categories WHERE parent_id = ? AND customer_id = ? ORDER BY priority DESC, title ASC',
      [categoryId, req.customer_id]
    );

    category.children = childCategories;

    // Get products count in this category
    const [productCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM products WHERE category_id = ? AND customer_id = ?',
      [categoryId, req.customer_id]
    );

    category.products_count = productCount[0].count;

    res.json({
      success: true,
      message: 'Category retrieved successfully',
      category: category
    });

  } catch (error) {
    console.error('Admin category detail error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Create new category endpoint
app.post('/admin/categories', authenticateToken, requirePermission('can_edit_categories'), async (req, res) => {
  try {
    const {
      parent_id,
      title,
      subtitle,
      image,
      category,
      featured,
      priority
    } = req.body;

    // Validate required fields
    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Title is required'
      });
    }

    // If parent_id is provided, check if parent category exists
    if (parent_id) {
      const [parentCheck] = await pool.execute(
        'SELECT id FROM categories WHERE id = ? AND customer_id = ? AND isActive = 1',
        [parent_id, req.customer_id]
      );

      if (parentCheck.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Parent category not found or inactive'
        });
      }
    }

    // Check if category slug already exists (if provided)
    if (category) {
      const [categoryCheck] = await pool.execute(
        'SELECT id FROM categories WHERE category = ? AND customer_id = ?',
        [category, req.customer_id]
      );

      if (categoryCheck.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Category slug already exists'
        });
      }
    }

    // Insert new category
    const [result] = await pool.execute(
      `INSERT INTO categories (
        customer_id, parent_id, title, subtitle, image, category, 
        featured, priority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.customer_id, parent_id || null, title, subtitle || null, 
        image || null, category || null, featured || 0, priority || 0
      ]
    );

    // Get the created category
    const [newCategory] = await pool.execute(
      'SELECT * FROM categories WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category: newCategory[0]
    });

  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update category endpoint
app.put('/admin/categories/:categoryId', authenticateToken, requirePermission('can_edit_categories'), async (req, res) => {
  try {
    const { categoryId } = req.params;
    const {
      parent_id,
      title,
      subtitle,
      image,
      category,
      featured,
      priority,
      isActive
    } = req.body;

    // Validate category ID
    if (!categoryId || isNaN(categoryId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid category ID is required'
      });
    }

    // Check if category exists for this customer
    const [categoryCheck] = await pool.execute(
      'SELECT id FROM categories WHERE id = ? AND customer_id = ?',
      [categoryId, req.customer_id]
    );

    if (categoryCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // If parent_id is provided, check if parent category exists and prevent circular reference
    if (parent_id) {
      if (parent_id == categoryId) {
        return res.status(400).json({
          success: false,
          message: 'Category cannot be its own parent'
        });
      }

      const [parentCheck] = await pool.execute(
        'SELECT id FROM categories WHERE id = ? AND customer_id = ? AND isActive = 1',
        [parent_id, req.customer_id]
      );

      if (parentCheck.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Parent category not found or inactive'
        });
      }
    }

    // If category slug is provided, check if it already exists
    if (category) {
      const [slugCheck] = await pool.execute(
        'SELECT id FROM categories WHERE category = ? AND customer_id = ? AND id != ?',
        [category, req.customer_id, categoryId]
      );

      if (slugCheck.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Category slug already exists'
        });
      }
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (parent_id !== undefined) {
      updateFields.push('parent_id = ?');
      updateValues.push(parent_id);
    }
    if (title !== undefined) {
      updateFields.push('title = ?');
      updateValues.push(title);
    }
    if (subtitle !== undefined) {
      updateFields.push('subtitle = ?');
      updateValues.push(subtitle);
    }
    if (image !== undefined) {
      updateFields.push('image = ?');
      updateValues.push(image);
    }
    if (category !== undefined) {
      updateFields.push('category = ?');
      updateValues.push(category);
    }
    if (featured !== undefined) {
      updateFields.push('featured = ?');
      updateValues.push(featured);
    }
    if (priority !== undefined) {
      updateFields.push('priority = ?');
      updateValues.push(priority);
    }
    if (isActive !== undefined) {
      updateFields.push('isActive = ?');
      updateValues.push(isActive);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    updateValues.push(categoryId);

    // Update category
    await pool.execute(
      `UPDATE categories SET ${updateFields.join(', ')} WHERE id = ? AND customer_id = ?`,
      [...updateValues, req.customer_id]
    );

    // Get updated category
    const [updatedCategory] = await pool.execute(
      'SELECT * FROM categories WHERE id = ? AND customer_id = ?',
      [categoryId, req.customer_id]
    );

    res.json({
      success: true,
      message: 'Category updated successfully',
      category: updatedCategory[0]
    });

  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Delete category endpoint (force delete with all products and sub-categories)
app.delete('/admin/categories/:categoryId', authenticateToken, requirePermission('can_edit_categories'), async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { force = false } = req.query;

    // Validate category ID
    if (!categoryId || isNaN(categoryId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid category ID is required'
      });
    }

    // Check if category exists for this customer
    const [categoryCheck] = await pool.execute(
      'SELECT id, title FROM categories WHERE id = ? AND customer_id = ?',
      [categoryId, req.customer_id]
    );

    if (categoryCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    if (force === 'true' || force === true) {
      // Force delete - remove everything recursively
      await deleteCategoryRecursive(categoryId, req.customer_id);
      
      res.json({
        success: true,
        message: 'Category and all related data deleted successfully (force delete)',
        category: {
          id: categoryCheck[0].id,
          title: categoryCheck[0].title
        }
      });
    } else {
      // Normal delete with checks
      // Check if category has products
      const [productsCheck] = await pool.execute(
        'SELECT COUNT(*) as count FROM products WHERE category_id = ? AND customer_id = ?',
        [categoryId, req.customer_id]
      );

      if (productsCheck[0].count > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete category with products. Use ?force=true to force delete or move products first.',
          products_count: productsCheck[0].count
        });
      }

      // Check if category has child categories
      const [childrenCheck] = await pool.execute(
        'SELECT COUNT(*) as count FROM categories WHERE parent_id = ? AND customer_id = ?',
        [categoryId, req.customer_id]
      );

      if (childrenCheck[0].count > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete category with child categories. Use ?force=true to force delete or move child categories first.',
          child_categories_count: childrenCheck[0].count
        });
      }

      // Normal delete (no products or children)
      await pool.execute(
        'DELETE FROM categories WHERE id = ? AND customer_id = ?',
        [categoryId, req.customer_id]
      );

      res.json({
        success: true,
        message: 'Category deleted successfully',
        category: {
          id: categoryCheck[0].id,
          title: categoryCheck[0].title
        }
      });
    }

  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Helper function to recursively delete category and all related data
async function deleteCategoryRecursive(categoryId, customerId) {
  try {
    // Get all child categories
    const [childCategories] = await pool.execute(
      'SELECT id FROM categories WHERE parent_id = ? AND customer_id = ?',
      [categoryId, customerId]
    );

    // Recursively delete all child categories
    for (const child of childCategories) {
      await deleteCategoryRecursive(child.id, customerId);
    }

    // Get all products in this category
    const [products] = await pool.execute(
      'SELECT id FROM products WHERE category_id = ? AND customer_id = ?',
      [categoryId, customerId]
    );

    // For each product, delete all related data in the correct order
    for (const product of products) {
      // Get all product_stock IDs for this product
      const [productStocks] = await pool.execute(
        'SELECT id FROM product_stock WHERE product_id = ? AND customer_id = ?',
        [product.id, customerId]
      );

      // Delete transaction_items that reference these product_stock entries
      for (const stock of productStocks) {
        await pool.execute(
          'DELETE FROM transaction_items WHERE license_id = ?',
          [stock.id]
        );
      }

      // Now we can safely delete product_stock
      await pool.execute(
        'DELETE FROM product_stock WHERE product_id = ? AND customer_id = ?',
        [product.id, customerId]
      );
    }

    // Delete all products in this category
    await pool.execute(
      'DELETE FROM products WHERE category_id = ? AND customer_id = ?',
      [categoryId, customerId]
    );

    // Finally, delete the category itself
    await pool.execute(
      'DELETE FROM categories WHERE id = ? AND customer_id = ?',
      [categoryId, customerId]
    );

  } catch (error) {
    console.error('Error in deleteCategoryRecursive:', error);
    throw error;
  }
}



















// ==================== ADMIN REPORTS API ====================

// Get comprehensive overview report for admin
app.get('/admin/reports/overview', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { period = '30' } = req.query; // days
    const periodDays = parseInt(period) || 30;

    // Get date range
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Overall statistics
    const [overallStats] = await pool.execute(`
      SELECT 
        (SELECT COUNT(*) FROM users WHERE customer_id = ?) as total_users,
        (SELECT COUNT(*) FROM products WHERE customer_id = ?) as total_products,
        (SELECT COUNT(*) FROM categories WHERE customer_id = ?) as total_categories,
        (SELECT COUNT(*) FROM product_stock WHERE customer_id = ?) as total_stock,
        (SELECT COUNT(*) FROM product_stock WHERE customer_id = ? AND sold = 0) as available_stock,
        (SELECT COUNT(*) FROM product_stock WHERE customer_id = ? AND sold = 1) as sold_stock,
        (SELECT COUNT(*) FROM transactions WHERE customer_id = ?) as total_transactions,
        (SELECT COALESCE(SUM(total_price), 0) FROM transactions WHERE customer_id = ?) as total_revenue,
        (SELECT COUNT(*) FROM topups WHERE customer_id = ?) as total_topups,
        (SELECT COALESCE(SUM(amount), 0) FROM topups WHERE customer_id = ? AND status = 'success') as total_topup_amount
    `, Array(10).fill(req.customer_id));

    // Recent period statistics
    const [periodStats] = await pool.execute(`
      SELECT 
        (SELECT COUNT(*) FROM users WHERE customer_id = ? AND created_at >= ?) as new_users,
        (SELECT COUNT(*) FROM transactions WHERE customer_id = ? AND created_at >= ?) as period_transactions,
        (SELECT COALESCE(SUM(total_price), 0) FROM transactions WHERE customer_id = ? AND created_at >= ?) as period_revenue,
        (SELECT COUNT(*) FROM topups WHERE customer_id = ? AND created_at >= ?) as period_topups,
        (SELECT COALESCE(SUM(amount), 0) FROM topups WHERE customer_id = ? AND status = 'success' AND created_at >= ?) as period_topup_amount,
        (SELECT COUNT(*) FROM product_stock WHERE customer_id = ? AND created_at >= ?) as period_stock_added
    `, [
      req.customer_id, startDate,
      req.customer_id, startDate,
      req.customer_id, startDate,
      req.customer_id, startDate,
      req.customer_id, startDate,
      req.customer_id, startDate
    ]);

    // Top selling products
    const [topProducts] = await pool.execute(`
      SELECT 
        p.id,
        p.title,
        COUNT(ti.id) as sales_count,
        SUM(ti.quantity) as total_quantity,
        SUM(ti.price * ti.quantity) as total_revenue
      FROM products p
      LEFT JOIN transaction_items ti ON p.id = ti.product_id
      LEFT JOIN transactions t ON ti.transaction_id = t.id
      WHERE p.customer_id = ? AND t.customer_id = ?
      GROUP BY p.id, p.title
      ORDER BY sales_count DESC, total_revenue DESC
      LIMIT 10
    `, [req.customer_id, req.customer_id]);

    // Recent transactions
    const [recentTransactions] = await pool.execute(`
      SELECT 
        t.id,
        t.bill_number,
        u.fullname as username,
        t.total_price as total_amount,
        'completed' as status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.customer_id = ?
      ORDER BY t.created_at DESC
      LIMIT 10
    `, [req.customer_id]);

    // Daily revenue for the period (for charts)
    const [dailyRevenue] = await pool.execute(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as transaction_count,
        COALESCE(SUM(total_price), 0) as revenue
      FROM transactions 
      WHERE customer_id = ? AND created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `, [req.customer_id, startDate]);

    res.json({
      success: true,
      period_days: periodDays,
      overview: {
        ...overallStats[0],
        ...periodStats[0]
      },
      top_products: topProducts,
      recent_transactions: recentTransactions,
      daily_revenue: dailyRevenue
    });

  } catch (error) {
    console.error('Admin overview report error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get detailed sales report
app.get('/admin/reports/sales', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { 
      start_date = null,
      end_date = null,
      page = 1,
      limit = 50
    } = req.query;

    const parsedPage = parseInt(page) || 1;
    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const offset = (parsedPage - 1) * parsedLimit;

    // Build date filters
    let dateFilter = '';
    const queryParams = [req.customer_id];
    
    if (start_date) {
      dateFilter += ' AND t.created_at >= ?';
      queryParams.push(new Date(start_date));
    }
    
    if (end_date) {
      dateFilter += ' AND t.created_at <= ?';
      queryParams.push(new Date(end_date));
    }


    // Get detailed sales data
    const [salesData] = await pool.execute(`
      SELECT 
        t.id,
        t.bill_number,
        u.fullname as username,
        u.email,
        t.total_price as total_amount,
        t.created_at,
        GROUP_CONCAT(
          CONCAT(p.title, ' (', ti.quantity, 'x', ti.price, ')')
          SEPARATOR '; '
        ) as items
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN transaction_items ti ON t.id = ti.transaction_id
      LEFT JOIN products p ON ti.product_id = p.id
      WHERE t.customer_id = ? ${dateFilter}
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT ${parsedLimit} OFFSET ${offset}
    `, queryParams);

    // Get summary statistics
    const [summary] = await pool.execute(`
      SELECT 
        COUNT(*) as total_transactions,
        COALESCE(SUM(total_price), 0) as total_revenue
      FROM transactions t
      WHERE t.customer_id = ? ${dateFilter}
    `, queryParams); // Use same queryParams without limit/offset

    const totalItems = summary[0].total_transactions;
    const totalPages = Math.ceil(totalItems / parsedLimit);

    res.json({
      success: true,
      data: salesData,
      summary: summary[0],
      pagination: {
        currentPage: parsedPage,
        totalPages,
        totalItems,
        itemsPerPage: parsedLimit,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1
      }
    });

  } catch (error) {
    console.error('Sales report error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get products performance report
app.get('/admin/reports/products', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { 
      category_id = null,
      sort_by = 'sales',
      period = '30'
    } = req.query;

    const periodDays = parseInt(period) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    let categoryFilter = '';
    const queryParams = [req.customer_id];
    
    if (category_id) {
      categoryFilter = ' AND p.category_id = ?';
      queryParams.push(category_id);
    }

    // Get products with sales data
    const [productsData] = await pool.execute(`
      SELECT 
        p.id,
        p.title,
        p.price,
        p.reseller_price,
        p.stock,
        p.isActive,
        c.title as category_title,
        COALESCE(sales.total_sales, 0) as total_sales,
        COALESCE(sales.total_quantity, 0) as total_quantity,
        COALESCE(sales.total_revenue, 0) as total_revenue,
        COALESCE(period_sales.period_sales, 0) as period_sales,
        COALESCE(period_sales.period_revenue, 0) as period_revenue,
        COALESCE(stock_info.total_stock, 0) as total_license_keys,
        COALESCE(stock_info.available_stock, 0) as available_license_keys,
        COALESCE(stock_info.sold_stock, 0) as sold_license_keys
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN (
        SELECT 
          ti.product_id,
          COUNT(t.id) as total_sales,
          SUM(ti.quantity) as total_quantity,
          SUM(ti.price * ti.quantity) as total_revenue
        FROM transaction_items ti
        LEFT JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.customer_id = ?
        GROUP BY ti.product_id
      ) sales ON p.id = sales.product_id
      LEFT JOIN (
        SELECT 
          ti.product_id,
          COUNT(t.id) as period_sales,
          SUM(ti.price * ti.quantity) as period_revenue
        FROM transaction_items ti
        LEFT JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.customer_id = ? AND t.created_at >= ?
        GROUP BY ti.product_id
      ) period_sales ON p.id = period_sales.product_id
      LEFT JOIN (
        SELECT 
          product_id,
          COUNT(*) as total_stock,
          SUM(CASE WHEN sold = 0 THEN 1 ELSE 0 END) as available_stock,
          SUM(CASE WHEN sold = 1 THEN 1 ELSE 0 END) as sold_stock
        FROM product_stock
        WHERE customer_id = ?
        GROUP BY product_id
      ) stock_info ON p.id = stock_info.product_id
      WHERE p.customer_id = ? ${categoryFilter}
      ORDER BY ${sort_by === 'revenue' ? 'total_revenue' : 
                 sort_by === 'stock' ? 'available_license_keys' : 
                 'total_sales'} DESC
    `, [req.customer_id, req.customer_id, startDate, req.customer_id, req.customer_id]);

    // Get categories summary
    const [categoriesData] = await pool.execute(`
      SELECT 
        c.id,
        c.title,
        COUNT(p.id) as products_count,
        COALESCE(SUM(sales.total_sales), 0) as total_sales,
        COALESCE(SUM(sales.total_revenue), 0) as total_revenue
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id AND p.customer_id = ?
      LEFT JOIN (
        SELECT 
          ti.product_id,
          COUNT(t.id) as total_sales,
          SUM(ti.price * ti.quantity) as total_revenue
        FROM transaction_items ti
        LEFT JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.customer_id = ?
        GROUP BY ti.product_id
      ) sales ON p.id = sales.product_id
      WHERE c.customer_id = ?
      GROUP BY c.id, c.title
      ORDER BY total_revenue DESC
    `, [req.customer_id, req.customer_id, req.customer_id]);

    res.json({
      success: true,
      period_days: periodDays,
      products: productsData,
      categories: categoriesData
    });

  } catch (error) {
    console.error('Products report error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get users activity report
app.get('/admin/reports/users', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { 
      period = '30',
      page = 1,
      limit = 50
    } = req.query;

    const periodDays = parseInt(period) || 30;
    const parsedPage = parseInt(page) || 1;
    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const offset = (parsedPage - 1) * parsedLimit;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // Get users with activity data
    const usersQueryParams = [startDate, startDate, req.customer_id, req.customer_id, req.customer_id];
    const [usersData] = await pool.execute(`
      SELECT 
        u.id,
        u.fullname as username,
        u.email,
        u.money as balance,
        CASE WHEN u.role = 'reseller' THEN 1 ELSE 0 END as is_reseller,
        u.created_at,
        COALESCE(stats.total_transactions, 0) as total_transactions,
        COALESCE(stats.total_spent, 0) as total_spent,
        COALESCE(stats.period_transactions, 0) as period_transactions,
        COALESCE(stats.period_spent, 0) as period_spent,
        COALESCE(topup_stats.total_topups, 0) as total_topups,
        COALESCE(topup_stats.total_topup_amount, 0) as total_topup_amount,
        stats.last_transaction_date
      FROM users u
      LEFT JOIN (
        SELECT 
          user_id,
          COUNT(*) as total_transactions,
          SUM(total_price) as total_spent,
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as period_transactions,
          SUM(CASE WHEN created_at >= ? THEN total_price ELSE 0 END) as period_spent,
          MAX(created_at) as last_transaction_date
        FROM transactions 
        WHERE customer_id = ?
        GROUP BY user_id
      ) stats ON u.id = stats.user_id
      LEFT JOIN (
        SELECT 
          user_id,
          COUNT(*) as total_topups,
          SUM(amount) as total_topup_amount
        FROM topups 
        WHERE customer_id = ?
        GROUP BY user_id
      ) topup_stats ON u.id = topup_stats.user_id
      WHERE u.customer_id = ?
      ORDER BY total_spent DESC
      LIMIT ${parsedLimit} OFFSET ${offset}
    `, usersQueryParams);

    // Get total count
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM users WHERE customer_id = ?',
      [req.customer_id]
    );

    const totalItems = countResult[0].total;
    const totalPages = Math.ceil(totalItems / parsedLimit);

    // Get summary statistics
    const [summary] = await pool.execute(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN created_at >= ? THEN 1 END) as new_users_period,
        COUNT(CASE WHEN role = 'reseller' THEN 1 END) as total_resellers,
        COALESCE(SUM(money), 0) as total_balance
      FROM users
      WHERE customer_id = ?
    `, [startDate, req.customer_id]);

    res.json({
      success: true,
      period_days: periodDays,
      data: usersData,
      summary: summary[0],
      pagination: {
        currentPage: parsedPage,
        totalPages,
        totalItems,
        itemsPerPage: parsedLimit,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1
      }
    });

  } catch (error) {
    console.error('Users report error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get topups report
app.get('/admin/reports/topups', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { 
      start_date = null,
      end_date = null,
      status = null,
      method = null,
      page = 1,
      limit = 50
    } = req.query;

    const parsedPage = parseInt(page) || 1;
    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const offset = (parsedPage - 1) * parsedLimit;

    // Build filters
    let filters = '';
    const queryParams = [req.customer_id, req.customer_id];
    
    if (start_date) {
      filters += ' AND t.created_at >= ?';
      queryParams.push(new Date(start_date));
    }
    
    if (end_date) {
      filters += ' AND t.created_at <= ?';
      queryParams.push(new Date(end_date));
    }

    if (status) {
      filters += ' AND t.status = ?';
      queryParams.push(status);
    }

    if (method) {
      filters += ' AND t.method = ?';
      queryParams.push(method);
    }

    // Get topups data
    const [topupsData] = await pool.execute(`
      SELECT 
        t.id,
        u.fullname as username,
        u.email,
        t.amount,
        t.method,
        t.transaction_ref,
        t.created_at,
        t.updated_at
      FROM topups t
      LEFT JOIN users u ON t.user_id = u.id AND u.customer_id = ?
      WHERE t.customer_id = ? ${filters}
      ORDER BY t.created_at DESC
      LIMIT ${parsedLimit} OFFSET ${offset}
    `, queryParams);

    // Get summary statistics
    const [summary] = await pool.execute(`
      SELECT 
        COUNT(*) as total_topups,
        COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) as total_success_amount,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as total_pending_amount,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN amount ELSE 0 END), 0) as total_failed_amount,
        COUNT(CASE WHEN status = 'success' THEN 1 END) as success_count,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
      FROM topups t
      WHERE t.customer_id = ? ${filters}
    `, [req.customer_id, ...queryParams.slice(2)]); // Use customer_id + the filter params

    // Get payment methods summary
    const [methodsSummary] = await pool.execute(`
      SELECT 
        method,
        COUNT(*) as count,
        COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) as success_amount
      FROM topups t
      WHERE t.customer_id = ? ${filters}
      GROUP BY method
      ORDER BY success_amount DESC
    `, [req.customer_id, ...queryParams.slice(2)]); // Use customer_id + the filter params

    const totalItems = summary[0].total_topups;
    const totalPages = Math.ceil(totalItems / parsedLimit);

    res.json({
      success: true,
      data: topupsData,
      summary: summary[0],
      methods_summary: methodsSummary,
      pagination: {
        currentPage: parsedPage,
        totalPages,
        totalItems,
        itemsPerPage: parsedLimit,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1
      }
    });

  } catch (error) {
    console.error('Topups report error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// ==================== STOCK MANAGEMENT API ====================

// Get all product stock with pagination and filters
app.get('/admin/stock', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { 
      productId = null,
      soldStatus = null, // 'sold', 'unsold', or null for all
      page = 1,
      limit = 50,
      search = '',
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = req.query;

    // Parse and validate pagination parameters
    const parsedPage = parseInt(page, 10) || 1;
    const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100); // Max 100 per page
    const offset = (parsedPage - 1) * parsedLimit;

    // Build base query
    let query = `
      SELECT 
        ps.id, ps.product_id, ps.license_key, ps.sold, ps.created_at,
        p.title as product_title, p.price, p.category_id,
        c.title as category_title
      FROM product_stock ps
      LEFT JOIN products p ON ps.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;

    const queryParams = [req.customer_id];

    // Add filters
    if (productId && !isNaN(productId)) {
      query += ' AND ps.product_id = ?';
      queryParams.push(parseInt(productId));
    }

    if (soldStatus === 'sold') {
      query += ' AND ps.sold = 1';
    } else if (soldStatus === 'unsold') {
      query += ' AND ps.sold = 0';
    }

    if (search && search.trim() !== '') {
      query += ' AND (ps.license_key LIKE ? OR p.title LIKE ? OR c.title LIKE ?)';
      const searchPattern = `%${search.trim()}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern);
    }

    // Add sorting
    const validSortFields = ['created_at', 'license_key', 'product_title', 'sold'];
    const validSortOrders = ['asc', 'desc'];
    
    const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'created_at';
    const finalSortOrder = validSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'desc';
    
    if (finalSortBy === 'product_title') {
      query += ` ORDER BY p.title ${finalSortOrder}`;
    } else {
      query += ` ORDER BY ps.${finalSortBy} ${finalSortOrder}`;
    }

    // Add pagination
    query += ' LIMIT ? OFFSET ?';
    queryParams.push(parsedLimit, offset);

    // Get stock data
    const [stocks] = await pool.execute(query, queryParams);

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM product_stock ps
      LEFT JOIN products p ON ps.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;
    
    const countParams = [req.customer_id];

    if (productId && !isNaN(productId)) {
      countQuery += ' AND ps.product_id = ?';
      countParams.push(parseInt(productId));
    }

    if (soldStatus === 'sold') {
      countQuery += ' AND ps.sold = 1';
    } else if (soldStatus === 'unsold') {
      countQuery += ' AND ps.sold = 0';
    }

    if (search && search.trim() !== '') {
      countQuery += ' AND (ps.license_key LIKE ? OR p.title LIKE ? OR c.title LIKE ?)';
      const searchPattern = `%${search.trim()}%`;
      countParams.push(searchPattern, searchPattern, searchPattern);
    }

    const [countResult] = await pool.execute(countQuery, countParams);
    const totalItems = countResult[0].total;
    const totalPages = Math.ceil(totalItems / parsedLimit);

    res.json({
      success: true,
      data: stocks,
      pagination: {
        currentPage: parsedPage,
        totalPages,
        totalItems,
        itemsPerPage: parsedLimit,
        hasNextPage: parsedPage < totalPages,
        hasPrevPage: parsedPage > 1
      }
    });

  } catch (error) {
    console.error('Get stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get stock for specific product
app.get('/admin/stock/:productId', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { productId } = req.params;

    // Validate product ID
    if (!productId || isNaN(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid product ID is required'
      });
    }

    // Check if product exists for this customer
    const [productCheck] = await pool.execute(
      'SELECT id, title FROM products WHERE id = ? AND customer_id = ?',
      [productId, req.customer_id]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Get stock for this product
    const [stocks] = await pool.execute(`
      SELECT 
        ps.id, ps.product_id, ps.license_key, ps.sold, ps.created_at,
        p.title as product_title, p.price
      FROM product_stock ps
      LEFT JOIN products p ON ps.product_id = p.id
      WHERE ps.product_id = ? AND ps.customer_id = ?
      ORDER BY ps.created_at DESC
    `, [productId, req.customer_id]);

    // Get summary
    const [summary] = await pool.execute(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN sold = 0 THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN sold = 1 THEN 1 ELSE 0 END) as sold
      FROM product_stock 
      WHERE product_id = ? AND customer_id = ?
    `, [productId, req.customer_id]);

    res.json({
      success: true,
      product: productCheck[0],
      stocks,
      summary: summary[0]
    });

  } catch (error) {
    console.error('Get product stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Add new license key to stock
app.post('/admin/stock', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { product_id, license_key } = req.body;

    // Validate required fields
    if (!product_id || !license_key) {
      return res.status(400).json({
        success: false,
        message: 'Product ID and license key are required'
      });
    }

    // Check if product exists for this customer
    const [productCheck] = await pool.execute(
      'SELECT id, title FROM products WHERE id = ? AND customer_id = ?',
      [product_id, req.customer_id]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // License key validation removed - allowing duplicates

    // Insert new stock
    const [result] = await pool.execute(
      'INSERT INTO product_stock (product_id, license_key, customer_id) VALUES (?, ?, ?)',
      [product_id, license_key, req.customer_id]
    );

    // Update product stock count
    await pool.execute(
      'UPDATE products SET stock = stock + 1 WHERE id = ? AND customer_id = ?',
      [product_id, req.customer_id]
    );

    // Get created stock with product details
    const [newStock] = await pool.execute(`
      SELECT 
        ps.id, ps.product_id, ps.license_key, ps.sold, ps.created_at,
        p.title as product_title, p.price, p.stock
      FROM product_stock ps
      LEFT JOIN products p ON ps.product_id = p.id
      WHERE ps.id = ?
    `, [result.insertId]);

    res.status(201).json({
      success: true,
      message: 'License key added successfully',
      stock: newStock[0]
    });

  } catch (error) {
    console.error('Add stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update license key
app.put('/admin/stock/:stockId', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { stockId } = req.params;
    const { license_key, sold } = req.body;

    // Validate stock ID
    if (!stockId || isNaN(stockId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid stock ID is required'
      });
    }

    // Check if stock exists for this customer's products
    const [stockCheck] = await pool.execute(`
      SELECT ps.id, ps.product_id, ps.license_key, ps.sold, p.title as product_title
      FROM product_stock ps
      LEFT JOIN products p ON ps.product_id = p.id
      WHERE ps.id = ? AND ps.customer_id = ?
    `, [stockId, req.customer_id]);

    if (stockCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Stock not found'
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (license_key !== undefined) {
      // License key validation removed - allowing duplicates
      updateFields.push('license_key = ?');
      updateValues.push(license_key);
    }

    if (sold !== undefined) {
      updateFields.push('sold = ?');
      updateValues.push(sold ? 1 : 0);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    updateValues.push(stockId);

    // Update stock
    await pool.execute(
      `UPDATE product_stock SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Get updated stock
    const [updatedStock] = await pool.execute(`
      SELECT 
        ps.id, ps.product_id, ps.license_key, ps.sold, ps.created_at,
        p.title as product_title, p.price
      FROM product_stock ps
      LEFT JOIN products p ON ps.product_id = p.id
      WHERE ps.id = ?
    `, [stockId]);

    res.json({
      success: true,
      message: 'Stock updated successfully',
      stock: updatedStock[0]
    });

  } catch (error) {
    console.error('Update stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Delete license key from stock
app.delete('/admin/stock/:stockId', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { stockId } = req.params;

    // Validate stock ID
    if (!stockId || isNaN(stockId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid stock ID is required'
      });
    }

    // Check if stock exists for this customer's products
    const [stockCheck] = await pool.execute(`
      SELECT ps.id, ps.product_id, ps.license_key, ps.sold, p.title as product_title
      FROM product_stock ps
      LEFT JOIN products p ON ps.product_id = p.id
      WHERE ps.id = ? AND ps.customer_id = ?
    `, [stockId, req.customer_id]);

    if (stockCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Stock not found'
      });
    }

    // Check if license key has been sold
    if (stockCheck[0].sold === 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete sold license key'
      });
    }

    // Delete stock
    await pool.execute(
      'DELETE FROM product_stock WHERE id = ?',
      [stockId]
    );

    // Update product stock count (decrease by 1)
    await pool.execute(
      'UPDATE products SET stock = GREATEST(stock - 1, 0) WHERE id = ? AND customer_id = ?',
      [stockCheck[0].product_id, req.customer_id]
    );

    res.json({
      success: true,
      message: 'Stock deleted successfully',
      stock: {
        id: stockCheck[0].id,
        license_key: stockCheck[0].license_key,
        product_title: stockCheck[0].product_title
      }
    });

  } catch (error) {
    console.error('Delete stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Bulk add license keys
app.post('/admin/stock/bulk', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { product_id, license_keys } = req.body;

    // Validate required fields
    if (!product_id || !license_keys || !Array.isArray(license_keys) || license_keys.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Product ID and array of license keys are required'
      });
    }

    // Check if product exists for this customer
    const [productCheck] = await pool.execute(
      'SELECT id, title FROM products WHERE id = ? AND customer_id = ?',
      [product_id, req.customer_id]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Filter out empty license keys (allow duplicates)
    const cleanKeys = license_keys.filter(key => key && key.trim());

    if (cleanKeys.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid license keys provided'
      });
    }

    // Bulk insert all license keys (duplicates allowed)
    const insertValues = cleanKeys.map(key => [product_id, key, req.customer_id]);
    
    await pool.execute(
      `INSERT INTO product_stock (product_id, license_key, customer_id) VALUES ${insertValues.map(() => '(?, ?, ?)').join(', ')}`,
      insertValues.flat()
    );

    // Update product stock count by the number of keys added
    await pool.execute(
      'UPDATE products SET stock = stock + ? WHERE id = ? AND customer_id = ?',
      [cleanKeys.length, product_id, req.customer_id]
    );

    res.status(201).json({
      success: true,
      message: `Successfully added ${cleanKeys.length} license keys`,
      added_count: cleanKeys.length,
      added_keys: cleanKeys
    });

  } catch (error) {
    console.error('Bulk add stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Sync product stock counts with actual license keys
app.post('/admin/stock/sync', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { product_id = null } = req.body;

    let whereClause = 'WHERE p.customer_id = ?';
    let queryParams = [req.customer_id];

    if (product_id) {
      whereClause += ' AND p.id = ?';
      queryParams.push(product_id);
    }

    // Calculate actual stock counts from product_stock table
    const [stockCounts] = await pool.execute(`
      SELECT 
        p.id as product_id,
        p.title as product_title,
        p.stock as current_stock,
        COALESCE(stock_count.actual_count, 0) as actual_stock,
        COALESCE(stock_count.available_count, 0) as available_stock,
        COALESCE(stock_count.sold_count, 0) as sold_stock
      FROM products p
      LEFT JOIN (
        SELECT 
          ps.product_id,
          COUNT(*) as actual_count,
          SUM(CASE WHEN ps.sold = 0 THEN 1 ELSE 0 END) as available_count,
          SUM(CASE WHEN ps.sold = 1 THEN 1 ELSE 0 END) as sold_count
        FROM product_stock ps
        GROUP BY ps.product_id
      ) stock_count ON p.id = stock_count.product_id
      ${whereClause}
    `, queryParams);

    // Update products with correct stock counts
    const updates = [];
    for (const product of stockCounts) {
      if (product.current_stock !== product.actual_stock) {
        await pool.execute(
          'UPDATE products SET stock = ? WHERE id = ? AND customer_id = ?',
          [product.actual_stock, product.product_id, req.customer_id]
        );
        updates.push({
          product_id: product.product_id,
          product_title: product.product_title,
          old_stock: product.current_stock,
          new_stock: product.actual_stock,
          available: product.available_stock,
          sold: product.sold_stock
        });
      }
    }

    res.json({
      success: true,
      message: `Stock counts synchronized for ${updates.length} products`,
      updates,
      total_products_checked: stockCounts.length
    });

  } catch (error) {
    console.error('Sync stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get stock analytics
app.get('/admin/stock/analytics', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    // Get overall stock statistics
    const [overallStats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_stock,
        SUM(CASE WHEN sold = 0 THEN 1 ELSE 0 END) as available_stock,
        SUM(CASE WHEN sold = 1 THEN 1 ELSE 0 END) as sold_stock
      FROM product_stock 
      WHERE customer_id = ?
    `, []);

    // Get stock by product
    const [productStats] = await pool.execute(`
      SELECT 
        p.id as product_id,
        p.title as product_title,
        COUNT(*) as total_stock,
        SUM(CASE WHEN ps.sold = 0 THEN 1 ELSE 0 END) as available_stock,
        SUM(CASE WHEN ps.sold = 1 THEN 1 ELSE 0 END) as sold_stock,
        ROUND((SUM(CASE WHEN ps.sold = 1 THEN 1 ELSE 0 END) / COUNT(*)) * 100, 2) as sold_percentage
      FROM product_stock ps
      LEFT JOIN products p ON ps.product_id = p.id
      WHERE ps.customer_id = ?
      GROUP BY p.id, p.title
      ORDER BY total_stock DESC
    `, []);

    // Get recent stock activity (last 30 days)
    const [recentActivity] = await pool.execute(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as keys_added
      FROM product_stock 
      WHERE customer_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `, []);

    // Calculate overall statistics
    const overall = overallStats[0];
    const soldPercentage = overall.total_stock > 0 
      ? Math.round((overall.sold_stock / overall.total_stock) * 100) 
      : 0;

    res.json({
      success: true,
      analytics: {
        overall: {
          ...overall,
          sold_percentage: soldPercentage
        },
        by_product: productStats,
        recent_activity: recentActivity
      }
    });

  } catch (error) {
    console.error('Stock analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// ====================================
// ADMIN USER MANAGEMENT APIs
// ====================================

// Get all users (Admin only)
app.get('/admin/users', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', role = '' } = req.query;
    
    // Parse pagination parameters first
    const parsedPage = parseInt(page, 10) || 1;
    const parsedLimit = parseInt(limit, 10) || 10;
    const parsedOffset = (parsedPage - 1) * parsedLimit;

    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    // Build search conditions
    let searchConditions = 'WHERE u.customer_id = ?';
    let searchParams = [req.customer_id];

    if (search) {
      searchConditions += ' AND (u.fullname LIKE ? OR u.email LIKE ?)';
      searchParams.push(`%${search}%`, `%${search}%`);
    }

    if (role) {
      searchConditions += ' AND u.role = ?';
      searchParams.push(role);
    }

    // Get total count
    const [totalResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM users u ${searchConditions}`,
      searchParams
    );
    const total = totalResult[0].total;
    
    // Get users with pagination
    // Sanitize LIMIT and OFFSET values for direct SQL interpolation
    const limitSafe = Math.min(Math.max(parseInt(parsedLimit, 10) || 10, 1), 100);
    const offsetSafe = Math.max(parseInt(parsedOffset, 10) || 0, 0);
    
    console.log('Admin Users Query Debug:', {
      searchConditions,
      searchParams,
      limitSafe,
      offsetSafe,
      paramCount: searchParams.length,
      placeholderCount: (searchConditions + ' ORDER BY u.created_at DESC').match(/\?/g)?.length || 0
    });
    
    const [users] = await pool.execute(
      `SELECT 
        u.id,
        u.fullname,
        u.email,
        u.role,
        u.money,
        u.points,
        u.discord_id,
        u.created_at,
        r.can_edit_categories,
        r.can_edit_products,
        r.can_edit_users,
        r.can_edit_orders,
        r.can_manage_keys,
        r.can_view_reports,
        r.can_manage_promotions,
        r.can_manage_settings,
        r.can_access_reseller_price
      FROM users u
      LEFT JOIN roles r ON u.role = r.rank_name
      ${searchConditions}
      ORDER BY u.created_at DESC
      LIMIT ${limitSafe} OFFSET ${offsetSafe}`,
      searchParams
    );

    res.json({
      success: true,
      message: 'Users retrieved successfully',
      data: {
        users: users.map(user => ({
          id: user.id,
          fullname: user.fullname,
          email: user.email,
          role: user.role,
          money: user.money,
          points: user.points,
          discord_id: user.discord_id,
          created_at: user.created_at,
          permissions: {
            can_edit_categories: Boolean(user.can_edit_categories),
            can_edit_products: Boolean(user.can_edit_products),
            can_edit_users: Boolean(user.can_edit_users),
            can_edit_orders: Boolean(user.can_edit_orders),
            can_manage_keys: Boolean(user.can_manage_keys),
            can_view_reports: Boolean(user.can_view_reports),
            can_manage_promotions: Boolean(user.can_manage_promotions),
            can_manage_settings: Boolean(user.can_manage_settings),
            can_access_reseller_price: Boolean(user.can_access_reseller_price)
          }
        })),
        pagination: {
          page: parsedPage,
          limit: limitSafe,
          total: total,
          totalPages: Math.ceil(total / limitSafe)
        }
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Create new user (Admin only)
app.post('/admin/users', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const { fullname, email, password, role = 'member', money = 0, points = 0, discord_id } = req.body;

    // Validate required fields
    if (!fullname || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Fullname, email, and password are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    // Check if user already exists
    const [existingUsers] = await pool.execute(
      'SELECT id FROM users WHERE email = ? AND customer_id = ?',
      [email, req.customer_id]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Validate role exists
    const [roleCheck] = await pool.execute(
      'SELECT id FROM roles WHERE rank_name = ?',
      [role]
    );

    if (roleCheck.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Available roles: member, moderator, admin, super_admin, reseller'
      });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert new user
    const [result] = await pool.execute(
      'INSERT INTO users (customer_id, fullname, email, password, role, money, points, discord_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.customer_id, fullname, email, hashedPassword, role, money, points, discord_id || null]
    );

    // Get the created user with role info
    const [newUser] = await pool.execute(
      `SELECT 
        u.id,
        u.fullname,
        u.email,
        u.role,
        u.money,
        u.points,
        u.discord_id,
        u.created_at,
        r.can_edit_categories,
        r.can_edit_products,
        r.can_edit_users,
        r.can_edit_orders,
        r.can_manage_keys,
        r.can_view_reports,
        r.can_manage_promotions,
        r.can_manage_settings,
        r.can_access_reseller_price
      FROM users u
      LEFT JOIN roles r ON u.role = r.rank_name
      WHERE u.id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: {
        user: {
          id: newUser[0].id,
          fullname: newUser[0].fullname,
          email: newUser[0].email,
          role: newUser[0].role,
          money: newUser[0].money,
          points: newUser[0].points,
          discord_id: newUser[0].discord_id,
          created_at: newUser[0].created_at,
          permissions: {
            can_edit_categories: Boolean(newUser[0].can_edit_categories),
            can_edit_products: Boolean(newUser[0].can_edit_products),
            can_edit_users: Boolean(newUser[0].can_edit_users),
            can_edit_orders: Boolean(newUser[0].can_edit_orders),
            can_manage_keys: Boolean(newUser[0].can_manage_keys),
            can_view_reports: Boolean(newUser[0].can_view_reports),
            can_manage_promotions: Boolean(newUser[0].can_manage_promotions),
            can_manage_settings: Boolean(newUser[0].can_manage_settings),
            can_access_reseller_price: Boolean(newUser[0].can_access_reseller_price)
          }
        }
      }
    });

  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update user (Admin only)
app.put('/admin/users/:id', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const { fullname, email, password, role, money, points, discord_id } = req.body;

    // Check if user exists
    const [existingUser] = await pool.execute(
      'SELECT id, email FROM users WHERE id = ? AND customer_id = ?',
      [id, req.customer_id]
    );

    if (existingUser.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (fullname !== undefined) {
      updateFields.push('fullname = ?');
      updateValues.push(fullname);
    }

    if (email !== undefined) {
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      // Check if email is already taken by another user
      if (email !== existingUser[0].email) {
        const [emailCheck] = await pool.execute(
          'SELECT id FROM users WHERE email = ? AND customer_id = ? AND id != ?',
          [email, req.customer_id, id]
        );

        if (emailCheck.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Email is already taken by another user'
          });
        }
      }

      updateFields.push('email = ?');
      updateValues.push(email);
    }

    if (password !== undefined) {
      // Hash new password
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }

    if (role !== undefined) {
      // Validate role exists
      const [roleCheck] = await pool.execute(
        'SELECT id FROM roles WHERE rank_name = ?',
        [role]
      );

      if (roleCheck.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role. Available roles: member, moderator, admin, super_admin, reseller'
        });
      }

      updateFields.push('role = ?');
      updateValues.push(role);
    }

    if (money !== undefined) {
      updateFields.push('money = ?');
      updateValues.push(money);
    }

    if (points !== undefined) {
      updateFields.push('points = ?');
      updateValues.push(points);
    }

    if (discord_id !== undefined) {
      updateFields.push('discord_id = ?');
      updateValues.push(discord_id || null);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    // Update user
    updateValues.push(id, req.customer_id);
    await pool.execute(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = ? AND customer_id = ?`,
      updateValues
    );

    // Get updated user
    const [updatedUser] = await pool.execute(
      `SELECT 
        u.id,
        u.fullname,
        u.email,
        u.role,
        u.money,
        u.points,
        u.discord_id,
        u.created_at,
        r.can_edit_categories,
        r.can_edit_products,
        r.can_edit_users,
        r.can_edit_orders,
        r.can_manage_keys,
        r.can_view_reports,
        r.can_manage_promotions,
        r.can_manage_settings,
        r.can_access_reseller_price
      FROM users u
      LEFT JOIN roles r ON u.role = r.rank_name
      WHERE u.id = ? AND u.customer_id = ?`,
      [id, req.customer_id]
    );

    res.json({
      success: true,
      message: 'User updated successfully',
      data: {
        user: {
          id: updatedUser[0].id,
          fullname: updatedUser[0].fullname,
          email: updatedUser[0].email,
          role: updatedUser[0].role,
          money: updatedUser[0].money,
          points: updatedUser[0].points,
          discord_id: updatedUser[0].discord_id,
          created_at: updatedUser[0].created_at,
          permissions: {
            can_edit_categories: Boolean(updatedUser[0].can_edit_categories),
            can_edit_products: Boolean(updatedUser[0].can_edit_products),
            can_edit_users: Boolean(updatedUser[0].can_edit_users),
            can_edit_orders: Boolean(updatedUser[0].can_edit_orders),
            can_manage_keys: Boolean(updatedUser[0].can_manage_keys),
            can_view_reports: Boolean(updatedUser[0].can_view_reports),
            can_manage_promotions: Boolean(updatedUser[0].can_manage_promotions),
            can_manage_settings: Boolean(updatedUser[0].can_manage_settings),
            can_access_reseller_price: Boolean(updatedUser[0].can_access_reseller_price)
          }
        }
      }
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Delete user (Admin only)
app.delete('/admin/users/:id', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists
    const [existingUser] = await pool.execute(
      'SELECT id, fullname, email FROM users WHERE id = ? AND customer_id = ?',
      [id, req.customer_id]
    );

    if (existingUser.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent self-deletion
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    // Delete user (CASCADE will handle related records)
    await pool.execute(
      'DELETE FROM users WHERE id = ? AND customer_id = ?',
      [id, req.customer_id]
    );

    res.json({
      success: true,
      message: 'User deleted successfully',
      deleted_user: {
        id: existingUser[0].id,
        fullname: existingUser[0].fullname,
        email: existingUser[0].email
      }
    });

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// ====================================
// ADMIN ROLES MANAGEMENT APIs
// ====================================

// Get all roles (Admin only)
app.get('/admin/roles', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const [roles] = await pool.execute(
      `SELECT 
        id,
        rank_name,
        can_edit_categories,
        can_edit_products,
        can_edit_users,
        can_edit_orders,
        can_manage_keys,
        can_view_reports,
        can_manage_promotions,
        can_manage_settings,
        can_access_reseller_price,
        created_at
      FROM roles 
      WHERE customer_id = ?
      ORDER BY id ASC`,
      [req.customer_id]
    );

    res.json({
      success: true,
      message: 'Roles retrieved successfully',
      data: {
        roles: roles.map(role => ({
          ...role,
          permissions: {
            can_edit_categories: Boolean(role.can_edit_categories),
            can_edit_products: Boolean(role.can_edit_products),
            can_edit_users: Boolean(role.can_edit_users),
            can_edit_orders: Boolean(role.can_edit_orders),
            can_manage_keys: Boolean(role.can_manage_keys),
            can_view_reports: Boolean(role.can_view_reports),
            can_manage_promotions: Boolean(role.can_manage_promotions),
            can_manage_settings: Boolean(role.can_manage_settings),
            can_access_reseller_price: Boolean(role.can_access_reseller_price)
          }
        }))
      }
    });

  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Create new role (Admin only)
app.post('/admin/roles', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const { 
      rank_name, 
      can_edit_categories = false,
      can_edit_products = false,
      can_edit_users = false,
      can_edit_orders = false,
      can_manage_keys = false,
      can_view_reports = false,
      can_manage_promotions = false,
      can_manage_settings = false,
      can_access_reseller_price = false
    } = req.body;

    // Validate required fields
    if (!rank_name) {
      return res.status(400).json({
        success: false,
        message: 'Role name is required'
      });
    }

    // Validate role name format (alphanumeric and underscore only)
    const roleNameRegex = /^[a-zA-Z0-9_]+$/;
    if (!roleNameRegex.test(rank_name)) {
      return res.status(400).json({
        success: false,
        message: 'Role name can only contain letters, numbers, and underscores'
      });
    }

    // Check if role already exists
    const [existingRole] = await pool.execute(
      'SELECT id FROM roles WHERE rank_name = ? AND customer_id = ?',
      [rank_name, req.customer_id]
    );

    if (existingRole.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Role with this name already exists'
      });
    }

    // Insert new role
    const [result] = await pool.execute(
      `INSERT INTO roles (
        customer_id,
        rank_name, 
        can_edit_categories, 
        can_edit_products, 
        can_edit_users, 
        can_edit_orders, 
        can_manage_keys, 
        can_view_reports, 
        can_manage_promotions, 
        can_manage_settings, 
        can_access_reseller_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.customer_id,
        rank_name,
        can_edit_categories ? 1 : 0,
        can_edit_products ? 1 : 0,
        can_edit_users ? 1 : 0,
        can_edit_orders ? 1 : 0,
        can_manage_keys ? 1 : 0,
        can_view_reports ? 1 : 0,
        can_manage_promotions ? 1 : 0,
        can_manage_settings ? 1 : 0,
        can_access_reseller_price ? 1 : 0
      ]
    );

    // Get the created role
    const [newRole] = await pool.execute(
      `SELECT 
        id,
        rank_name,
        can_edit_categories,
        can_edit_products,
        can_edit_users,
        can_edit_orders,
        can_manage_keys,
        can_view_reports,
        can_manage_promotions,
        can_manage_settings,
        can_access_reseller_price,
        created_at
      FROM roles 
      WHERE id = ? AND customer_id = ?`,
      [result.insertId, req.customer_id]
    );

    res.status(201).json({
      success: true,
      message: 'Role created successfully',
      data: {
        role: {
          ...newRole[0],
          permissions: {
            can_edit_categories: Boolean(newRole[0].can_edit_categories),
            can_edit_products: Boolean(newRole[0].can_edit_products),
            can_edit_users: Boolean(newRole[0].can_edit_users),
            can_edit_orders: Boolean(newRole[0].can_edit_orders),
            can_manage_keys: Boolean(newRole[0].can_manage_keys),
            can_view_reports: Boolean(newRole[0].can_view_reports),
            can_manage_promotions: Boolean(newRole[0].can_manage_promotions),
            can_manage_settings: Boolean(newRole[0].can_manage_settings),
            can_access_reseller_price: Boolean(newRole[0].can_access_reseller_price)
          }
        }
      }
    });

  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update role (Admin only)
app.put('/admin/roles/:id', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      rank_name,
      can_edit_categories,
      can_edit_products,
      can_edit_users,
      can_edit_orders,
      can_manage_keys,
      can_view_reports,
      can_manage_promotions,
      can_manage_settings,
      can_access_reseller_price
    } = req.body;

    // Check if role exists
    const [existingRole] = await pool.execute(
      'SELECT id, rank_name FROM roles WHERE id = ? AND customer_id = ?',
      [id, req.customer_id]
    );

    if (existingRole.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (rank_name !== undefined) {
      // Validate role name format
      const roleNameRegex = /^[a-zA-Z0-9_]+$/;
      if (!roleNameRegex.test(rank_name)) {
        return res.status(400).json({
          success: false,
          message: 'Role name can only contain letters, numbers, and underscores'
        });
      }

      // Check if role name is already taken by another role
      if (rank_name !== existingRole[0].rank_name) {
        const [nameCheck] = await pool.execute(
          'SELECT id FROM roles WHERE rank_name = ? AND id != ? AND customer_id = ?',
          [rank_name, id, req.customer_id]
        );

        if (nameCheck.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Role name is already taken by another role'
          });
        }
      }

      updateFields.push('rank_name = ?');
      updateValues.push(rank_name);
    }

    // Add permission fields
    if (can_edit_categories !== undefined) {
      updateFields.push('can_edit_categories = ?');
      updateValues.push(can_edit_categories ? 1 : 0);
    }

    if (can_edit_products !== undefined) {
      updateFields.push('can_edit_products = ?');
      updateValues.push(can_edit_products ? 1 : 0);
    }

    if (can_edit_users !== undefined) {
      updateFields.push('can_edit_users = ?');
      updateValues.push(can_edit_users ? 1 : 0);
    }

    if (can_edit_orders !== undefined) {
      updateFields.push('can_edit_orders = ?');
      updateValues.push(can_edit_orders ? 1 : 0);
    }

    if (can_manage_keys !== undefined) {
      updateFields.push('can_manage_keys = ?');
      updateValues.push(can_manage_keys ? 1 : 0);
    }

    if (can_view_reports !== undefined) {
      updateFields.push('can_view_reports = ?');
      updateValues.push(can_view_reports ? 1 : 0);
    }

    if (can_manage_promotions !== undefined) {
      updateFields.push('can_manage_promotions = ?');
      updateValues.push(can_manage_promotions ? 1 : 0);
    }

    if (can_manage_settings !== undefined) {
      updateFields.push('can_manage_settings = ?');
      updateValues.push(can_manage_settings ? 1 : 0);
    }

    if (can_access_reseller_price !== undefined) {
      updateFields.push('can_access_reseller_price = ?');
      updateValues.push(can_access_reseller_price ? 1 : 0);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    // Update role
    updateValues.push(id, req.customer_id);
    await pool.execute(
      `UPDATE roles SET ${updateFields.join(', ')} WHERE id = ? AND customer_id = ?`,
      updateValues
    );

    // Get updated role
    const [updatedRole] = await pool.execute(
      `SELECT 
        id,
        rank_name,
        can_edit_categories,
        can_edit_products,
        can_edit_users,
        can_edit_orders,
        can_manage_keys,
        can_view_reports,
        can_manage_promotions,
        can_manage_settings,
        can_access_reseller_price,
        created_at
      FROM roles 
      WHERE id = ? AND customer_id = ?`,
      [id, req.customer_id]
    );

    res.json({
      success: true,
      message: 'Role updated successfully',
      data: {
        role: {
          ...updatedRole[0],
          permissions: {
            can_edit_categories: Boolean(updatedRole[0].can_edit_categories),
            can_edit_products: Boolean(updatedRole[0].can_edit_products),
            can_edit_users: Boolean(updatedRole[0].can_edit_users),
            can_edit_orders: Boolean(updatedRole[0].can_edit_orders),
            can_manage_keys: Boolean(updatedRole[0].can_manage_keys),
            can_view_reports: Boolean(updatedRole[0].can_view_reports),
            can_manage_promotions: Boolean(updatedRole[0].can_manage_promotions),
            can_manage_settings: Boolean(updatedRole[0].can_manage_settings),
            can_access_reseller_price: Boolean(updatedRole[0].can_access_reseller_price)
          }
        }
      }
    });

  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Delete role (Admin only)
app.delete('/admin/roles/:id', authenticateToken, requirePermission('can_edit_users'), async (req, res) => {
  try {
    const { id } = req.params;

    // Check if role exists
    const [existingRole] = await pool.execute(
      'SELECT id, rank_name FROM roles WHERE id = ? AND customer_id = ?',
      [id, req.customer_id]
    );

    if (existingRole.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    // Check if any users are using this role
    const [usersWithRole] = await pool.execute(
      'SELECT COUNT(*) as count FROM users WHERE role = ? AND customer_id = ?',
      [existingRole[0].rank_name, req.customer_id]
    );

    if (usersWithRole[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete role "${existingRole[0].rank_name}" because ${usersWithRole[0].count} user(s) are currently using this role`
      });
    }

    // Delete role
    await pool.execute(
      'DELETE FROM roles WHERE id = ? AND customer_id = ?',
      [id, req.customer_id]
    );

    res.json({
      success: true,
      message: 'Role deleted successfully',
      data: {
        deleted_role: {
          id: existingRole[0].id,
          rank_name: existingRole[0].rank_name
        }
      }
    });

  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});






// ==================== SALES STATISTICS API ====================

// Get sales statistics (daily, weekly, monthly)
app.get('/stats', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    const { 
      period = 'daily', // 'daily', 'weekly', 'monthly'
      start_date = null,
      end_date = null,
      limit = 30 // จำนวนช่วงเวลาที่ต้องการดึง
    } = req.query;

    const customer_id = req.customer_id;
    
    // Ensure parsedLimit is a valid integer
    let parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      parsedLimit = 30;
    }
    parsedLimit = Math.min(parsedLimit, 365);

    // Build date filters
    let dateFilter = '';
    const dateParams = [];
    
    if (start_date) {
      dateFilter += ' AND t.created_at >= ?';
      dateParams.push(new Date(start_date));
    }
    
    if (end_date) {
      dateFilter += ' AND t.created_at <= ?';
      dateParams.push(new Date(end_date));
    }

    // สร้าง query ตาม period ที่เลือก
    let groupByClause = '';
    let selectDateFormat = '';
    
    if (period === 'daily') {
      selectDateFormat = 'DATE(t.created_at) as period_date';
      groupByClause = 'DATE(t.created_at)';
    } else if (period === 'weekly') {
      selectDateFormat = 'YEARWEEK(t.created_at, 1) as period_date';
      groupByClause = 'YEARWEEK(t.created_at, 1)';
    } else if (period === 'monthly') {
      selectDateFormat = 'DATE_FORMAT(t.created_at, "%Y-%m") as period_date';
      groupByClause = 'DATE_FORMAT(t.created_at, "%Y-%m")';
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid period. Must be "daily", "weekly", or "monthly"'
      });
    }

    // Query สำหรับสถิติการขาย
    const statsQuery = `
      SELECT 
        ${selectDateFormat},
        COUNT(DISTINCT t.id) as total_transactions,
        COUNT(DISTINCT t.user_id) as unique_customers,
        COALESCE(SUM(t.total_price), 0) as total_revenue,
        COALESCE(AVG(t.total_price), 0) as average_order_value,
        COUNT(ti.id) as total_items_sold,
        COALESCE(SUM(ti.quantity), 0) as total_quantity_sold,
        MIN(t.created_at) as period_start,
        MAX(t.created_at) as period_end
      FROM transactions t
      LEFT JOIN transaction_items ti ON t.id = ti.transaction_id AND ti.customer_id = ?
      WHERE t.customer_id = ? ${dateFilter}
      GROUP BY ${groupByClause}
      ORDER BY period_date DESC
      LIMIT ?
    `;

    // Build parameters in correct order
    const statsParams = [customer_id, customer_id, ...dateParams, parsedLimit];

    // ใช้ .query() แทน .execute() เพราะ LIMIT ? ไม่รองรับใน prepared statements ของ MySQL2
    const [stats] = await pool.query(statsQuery, statsParams);

    // Query สำหรับ top selling products ในช่วงเวลาที่เลือก
    const topProductsQuery = `
      SELECT 
        p.id,
        p.title,
        p.image,
        p.price,
        COUNT(DISTINCT ti.transaction_id) as times_sold,
        COALESCE(SUM(ti.quantity), 0) as total_quantity_sold,
        COALESCE(SUM(ti.price * ti.quantity), 0) as total_revenue
      FROM transaction_items ti
      LEFT JOIN products p ON ti.product_id = p.id
      LEFT JOIN transactions t ON ti.transaction_id = t.id
      WHERE ti.customer_id = ? AND t.customer_id = ? ${dateFilter}
      GROUP BY p.id, p.title, p.image, p.price
      ORDER BY total_revenue DESC
      LIMIT 10
    `;

    const topProductsParams = [customer_id, customer_id, ...dateParams];

    const [topProducts] = await pool.query(topProductsQuery, topProductsParams);

    // Query สำหรับ overall summary
    const summaryQuery = `
      SELECT 
        COUNT(DISTINCT t.id) as total_transactions,
        COUNT(DISTINCT t.user_id) as total_customers,
        COALESCE(SUM(t.total_price), 0) as total_revenue,
        COALESCE(AVG(t.total_price), 0) as average_order_value,
        COUNT(ti.id) as total_items_sold,
        COALESCE(SUM(ti.quantity), 0) as total_quantity_sold
      FROM transactions t
      LEFT JOIN transaction_items ti ON t.id = ti.transaction_id AND ti.customer_id = ?
      WHERE t.customer_id = ? ${dateFilter}
    `;

    const summaryParams = [customer_id, customer_id, ...dateParams];

    const [summary] = await pool.query(summaryQuery, summaryParams);

    // Format response
    res.json({
      success: true,
      message: 'Statistics retrieved successfully',
      data: {
        period: period,
        customer_id: customer_id,
        summary: summary[0],
        statistics: stats.map(stat => ({
          period_date: stat.period_date,
          period_start: stat.period_start,
          period_end: stat.period_end,
          total_transactions: parseInt(stat.total_transactions),
          unique_customers: parseInt(stat.unique_customers),
          total_revenue: parseFloat(stat.total_revenue),
          average_order_value: parseFloat(stat.average_order_value),
          total_items_sold: parseInt(stat.total_items_sold),
          total_quantity_sold: parseInt(stat.total_quantity_sold)
        })),
        top_products: topProducts.map(product => ({
          id: product.id,
          title: product.title,
          image: product.image,
          price: parseFloat(product.price),
          times_sold: parseInt(product.times_sold),
          total_quantity_sold: parseInt(product.total_quantity_sold),
          total_revenue: parseFloat(product.total_revenue)
        }))
      },
      filters: {
        start_date: start_date,
        end_date: end_date,
        limit: parsedLimit
      }
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Slip upload endpoint for automatic topup
app.post('/api/slip', authenticateToken, async (req, res) => {
  try {
    const { img } = req.body;

    if (!img) {
      return res.status(400).json({
        success: false,
        message: 'Image data is required'
      });
    }

    // Debug: Log image data info
    console.log('Image data length:', img.length);
    console.log('Image data starts with:', img.substring(0, 50));
    
    // Validate and clean image data
    let cleanImg = img;
    
    // Remove data URL prefix if present
    if (img.startsWith('data:image/')) {
      const base64Index = img.indexOf(',');
      if (base64Index !== -1) {
        cleanImg = img.substring(base64Index + 1);
        console.log('Removed data URL prefix, new length:', cleanImg.length);
      }
    }
    
    // Validate base64 format
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(cleanImg)) {
      console.log('Invalid base64 format');
      return res.status(400).json({
        success: false,
        message: 'รูปแบบข้อมูลรูปภาพไม่ถูกต้อง'
      });
    }

    console.log('Sending to API with clean image data length:', cleanImg.length);

    // Try different approaches for API call
    let slipResponse;
    
    try {
      // First try: Send as base64 string
      slipResponse = await axios.post('https://slip-c.oiioioiiioooioio.download/api/slip', {
        img: cleanImg
      }, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    } catch (error) {
      console.log('First attempt failed, trying with data URL format...');
      
      // Second try: Send with data URL format
      slipResponse = await axios.post('https://slip-c.oiioioiiioooioio.download/api/slip', {
        img: img
      }, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    const slipData = slipResponse.data;
    console.log('API Response:', JSON.stringify(slipData, null, 2));

    // Check if API response is successful (different structure)
    if (!slipData.data || slipData.message !== 'Slip processed successfully.') {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถประมวลผลสลิปได้',
        error: slipData.error || slipData.message || 'Invalid slip data',
        details: slipData
      });
    }

    const { ref, amount, receiver_name, receiver_id } = slipData.data;
    
    console.log('Slip data extracted:', {
      ref,
      amount,
      receiver_name,
      receiver_id
    });

    // Check if transaction_ref already exists in topups
    const [existingTopup] = await pool.execute(
      'SELECT id FROM topups WHERE transaction_ref = ? AND customer_id = ?',
      [ref, req.customer_id]
    );

    if (existingTopup.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'สลิปนี้ถูกใช้แล้ว',
        transaction_ref: ref
      });
    }

    // Get config to check receiver_name and bank_account_number and tax and api
    const [configs] = await pool.execute(
      'SELECT bank_account_name, bank_account_number, bank_account_name_thai, bank_account_tax, api FROM config WHERE customer_id = ?',
      [req.customer_id]
    );

    if (configs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'ไม่พบข้อมูลการตั้งค่าธนาคาร'
      });
    }

    const config = configs[0];
    
    // Priority 1: Check bank account number first
    const idMatch = config.bank_account_number && 
      (receiver_id.includes(config.bank_account_number) ||
       config.bank_account_number.includes(receiver_id));
    
    // Priority 2: Check English name if number doesn't match
    const englishNameMatch = !idMatch && config.bank_account_name && 
      (receiver_name.toLowerCase().includes(config.bank_account_name.toLowerCase()) ||
       config.bank_account_name.toLowerCase().includes(receiver_name.toLowerCase()));
    
    // Priority 3: Check Thai name if number and English name don't match
    const thaiNameMatch = !idMatch && !englishNameMatch && config.bank_account_name_thai && 
      (receiver_name.toLowerCase().includes(config.bank_account_name_thai.toLowerCase()) ||
       config.bank_account_name_thai.toLowerCase().includes(receiver_name.toLowerCase()));
    
    console.log('Validation checks:', {
      config_number: config.bank_account_number,
      slip_id: receiver_id,
      id_match: idMatch,
      config_english_name: config.bank_account_name,
      slip_name: receiver_name,
      english_name_match: englishNameMatch,
      config_thai_name: config.bank_account_name_thai,
      thai_name_match: thaiNameMatch
    });
    
    // Check if any validation passes
    if (!idMatch && !englishNameMatch && !thaiNameMatch) {
      console.log('Validation failed - no match found');
      return res.status(400).json({
        success: false,
        message: 'ข้อมูลผู้รับเงินไม่ตรงกับบัญชีธนาคารที่ตั้งค่าไว้',
        expected: {
          number: config.bank_account_number,
          english_name: config.bank_account_name,
          thai_name: config.bank_account_name_thai
        },
        received: {
          name: receiver_name,
          id: receiver_id
        }
      });
    }
    
    console.log('Validation passed - proceeding with topup');

    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'จำนวนเงินไม่ถูกต้อง'
      });
    }

    // Check if API key is configured
    if (!config.api || config.api.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'ไม่ได้ตั้งค่า API key กรุณาตั้งค่า API key ก่อนอัพโหลดสลิป'
      });
    }

    // Check resell_users balance before proceeding
    const [resellUsers] = await pool.execute(
      'SELECT user_id, balance FROM resell_users WHERE api = ?',
      [config.api]
    );

    if (resellUsers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'ไม่พบข้อมูล resell_user ที่เชื่อมกับ API key นี้'
      });
    }

    const resellUser = resellUsers[0];
    const currentBalance = parseFloat(resellUser.balance) || 0;

    if (currentBalance < 0.20) {
      return res.status(400).json({
        success: false,
        message: `เงินในบัญชี resell_users ไม่เพียงพอ (ปัจจุบัน: ${currentBalance.toFixed(2)} บาท, ต้องการ: 0.20 บาท)`,
        current_balance: currentBalance,
        required_balance: 0.20
      });
    }

    console.log('Resell user balance check passed:', {
      user_id: resellUser.user_id,
      current_balance: currentBalance,
      api_key: config.api
    });

    // Calculate tenant tax and net credit amount
    const taxRate = parseFloat(config.bank_account_tax || 0);
    const computedTaxAmount = Math.max(0, Math.round((amount * (isNaN(taxRate) ? 0 : taxRate / 100)) * 100) / 100);
    const creditedAmount = Math.max(0, Math.round((amount - computedTaxAmount) * 100) / 100);

    console.log('Tax calculation:', {
      tax_rate_percent: isNaN(taxRate) ? 0 : taxRate,
      gross_amount: amount,
      tax_amount: computedTaxAmount,
      credited_amount: creditedAmount
    });

    // Start transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      console.log('Starting topup process:', {
        customer_id: req.customer_id,
        user_id: req.user.id,
        amount_gross: amount,
        tax_rate_percent: isNaN(taxRate) ? 0 : taxRate,
        tax_amount: computedTaxAmount,
        amount_credited: creditedAmount,
        ref: ref
      });
      
      // Insert into topups table
      const [topupResult] = await connection.execute(
        'INSERT INTO topups (customer_id, user_id, amount, method, transaction_ref, status) VALUES (?, ?, ?, ?, ?, ?)',
        [req.customer_id, req.user.id, creditedAmount, 'bank_transfer', ref, 'success']
      );
      
      console.log('Topup record inserted:', topupResult.insertId);

      // Update user balance
      const [updateResult] = await connection.execute(
        'UPDATE users SET money = money + ? WHERE id = ? AND customer_id = ?',
        [creditedAmount, req.user.id, req.customer_id]
      );
      
      console.log('User balance update result:', updateResult.affectedRows);

      if (updateResult.affectedRows === 0) {
        throw new Error('ไม่สามารถอัปเดตเงินผู้ใช้ได้');
      }

      // Deduct 0.20 from resell_users (already validated above)
      const newResellBalance = Math.max(0, currentBalance - 0.20);
      
      await connection.execute(
        'UPDATE resell_users SET balance = ? WHERE user_id = ? AND api = ?',
        [newResellBalance, resellUser.user_id, config.api]
      );

      console.log(`Deducted 0.20 from resell_user ${resellUser.user_id}, balance: ${currentBalance} -> ${newResellBalance}`);

      // Get new balance
      const [userResult] = await connection.execute(
        'SELECT money FROM users WHERE id = ? AND customer_id = ?',
        [req.user.id, req.customer_id]
      );

      const newBalance = userResult[0].money;

      await connection.commit();

      console.log(`Slip topup successful: Customer ${req.customer_id}, User ${req.user.id}, Gross: ${amount}, Tax: ${computedTaxAmount}, Credited: ${creditedAmount}, Ref: ${ref}, New Balance: ${newBalance}`);

      res.json({
        success: true,
        message: 'เติมเงินสำเร็จ',
        data: {
          amount: creditedAmount,
          amount_gross: amount,
          tax_rate_percent: isNaN(taxRate) ? 0 : taxRate,
          tax_amount: computedTaxAmount,
          new_balance: newBalance,
          topup_id: topupResult.insertId,
          transaction_ref: ref,
          slip_data: slipData.data
        }
      });

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Slip processing error:', error);
    
    if (error.response) {
      // API error
      return res.status(500).json({
        success: false,
        message: 'ไม่สามารถประมวลผลสลิปได้',
        error: error.response.data?.message || 'API error'
      });
    }

    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการประมวลผลสลิป',
      error: error.message
    });
  }
});

// ==================== PRODUCT CLAIMS SYSTEM ====================

// Create a new product claim
app.post('/api/product-claims', authenticateToken, async (req, res) => {
  try {
    const { transaction_id, product_id, claim_reason } = req.body;
    
    if (!transaction_id || !product_id || !claim_reason) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Verify transaction exists and belongs to user
    const [transactions] = await pool.execute(
      'SELECT * FROM transactions WHERE id = ? AND user_id = ? AND customer_id = ?',
      [transaction_id, req.user.id, req.customer_id]
    );
    
    if (transactions.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    // Check if this transaction already has a claim
    const [existingClaims] = await pool.execute(
      'SELECT id FROM product_claims WHERE transaction_id = ? AND customer_id = ?',
      [transaction_id, req.customer_id]
    );
    
    if (existingClaims.length > 0) {
      return res.status(400).json({ error: 'This transaction already has a claim' });
    }
    
    // Get product price from transaction items
    const [items] = await pool.execute(
      'SELECT price FROM transaction_items WHERE transaction_id = ? AND product_id = ?',
      [transaction_id, product_id]
    );
    
    if (items.length === 0) {
      return res.status(404).json({ error: 'Product not found in transaction' });
    }
    
    const product_price = items[0].price;
    
    // Create claim
    const [result] = await pool.execute(
      'INSERT INTO product_claims (customer_id, user_id, transaction_id, product_id, product_price, claim_reason) VALUES (?, ?, ?, ?, ?, ?)',
      [req.customer_id, req.user.id, transaction_id, product_id, product_price, claim_reason]
    );
    
    res.status(201).json({
      message: 'Claim created successfully',
      claim_id: result.insertId
    });
  } catch (error) {
    console.error('Error creating claim:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all product claims (requires can_edit_orders permission)
app.get('/api/product-claims', authenticateToken, requirePermission('can_edit_orders'), async (req, res) => {
  try {
    const [claims] = await pool.execute(`
      SELECT 
        pc.*,
        u.fullname as user_name,
        u.email as user_email,
        p.title as product_title,
        t.bill_number
      FROM product_claims pc
      JOIN users u ON pc.user_id = u.id
      JOIN products p ON pc.product_id = p.id
      JOIN transactions t ON pc.transaction_id = t.id
      WHERE pc.customer_id = ?
      ORDER BY pc.created_at DESC
    `, [req.customer_id]);
    
    res.json(claims);
  } catch (error) {
    console.error('Error fetching claims:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get product claim by ID
app.get('/api/product-claims/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [claims] = await pool.execute(`
      SELECT 
        pc.*,
        u.fullname as user_name,
        u.email as user_email,
        p.title as product_title,
        t.bill_number
      FROM product_claims pc
      JOIN users u ON pc.user_id = u.id
      JOIN products p ON pc.product_id = p.id
      JOIN transactions t ON pc.transaction_id = t.id
      WHERE pc.id = ? AND pc.customer_id = ?
    `, [id, req.customer_id]);
    
    if (claims.length === 0) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    
    // Check if user has permission or is the claim owner
    const [userRoles] = await pool.execute(
      `SELECT r.can_edit_orders
      FROM users u
      LEFT JOIN roles r ON u.role = r.rank_name AND r.customer_id = u.customer_id
      WHERE u.id = ?`,
      [req.user.id]
    );
    
    const hasPermission = userRoles.length > 0 && userRoles[0].can_edit_orders;
    const isOwner = claims[0].user_id === req.user.id;
    
    if (!hasPermission && !isOwner) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    res.json(claims[0]);
  } catch (error) {
    console.error('Error fetching claim:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update claim status (requires can_edit_orders permission)
app.put('/api/product-claims/:id/status', authenticateToken, requirePermission('can_edit_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['pending', 'approved', 'rejected', 'refunded'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const [result] = await pool.execute(
      'UPDATE product_claims SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND customer_id = ?',
      [status, id, req.customer_id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    
    res.json({ message: 'Status updated successfully' });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add admin note to claim (requires can_edit_orders permission)
app.put('/api/product-claims/:id/note', authenticateToken, requirePermission('can_edit_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_note } = req.body;
    
    const [result] = await pool.execute(
      'UPDATE product_claims SET admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND customer_id = ?',
      [admin_note, id, req.customer_id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    
    res.json({ message: 'Note updated successfully' });
  } catch (error) {
    console.error('Error updating note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Process refund for approved claim (requires can_edit_orders permission)
app.post('/api/product-claims/:id/refund', authenticateToken, requirePermission('can_edit_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get claim details
    const [claims] = await pool.execute(
      'SELECT * FROM product_claims WHERE id = ? AND customer_id = ? AND status = "approved"',
      [id, req.customer_id]
    );
    
    if (claims.length === 0) {
      return res.status(404).json({ error: 'Approved claim not found' });
    }
    
    const claim = claims[0];
    
    // Start transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    try {
      // Add money back to user
      await connection.execute(
        'UPDATE users SET money = money + ? WHERE id = ? AND customer_id = ?',
        [claim.product_price, claim.user_id, req.customer_id]
      );
      
      // Update claim status to processed (optional - you can add this status)
      await connection.execute(
        'UPDATE product_claims SET status = "refunded", updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [id]
      );
      
      await connection.commit();
      
      res.json({ 
        message: 'Refund processed successfully',
        refund_amount: claim.product_price
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error processing refund:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete product claim (requires can_edit_orders permission)
app.delete('/api/product-claims/:id', authenticateToken, requirePermission('can_edit_orders'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const [result] = await pool.execute(
      'DELETE FROM product_claims WHERE id = ? AND customer_id = ?',
      [id, req.customer_id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    
    res.json({ message: 'Claim deleted successfully' });
  } catch (error) {
    console.error('Error deleting claim:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's own claims
app.get('/api/user/product-claims', authenticateToken, async (req, res) => {
  try {
    const [claims] = await pool.execute(`
      SELECT 
        pc.*,
        p.title as product_title,
        t.bill_number
      FROM product_claims pc
      JOIN products p ON pc.product_id = p.id
      JOIN transactions t ON pc.transaction_id = t.id
      WHERE pc.user_id = ? AND pc.customer_id = ?
      ORDER BY pc.created_at DESC
    `, [req.user.id, req.customer_id]);
    
    res.json(claims);
  } catch (error) {
    console.error('Error fetching user claims:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available transactions for claim (user's own transactions)
app.get('/api/user/transactions-for-claim', authenticateToken, async (req, res) => {
  try {
    const [transactions] = await pool.execute(`
      SELECT 
        t.id,
        t.bill_number,
        t.total_price,
        t.created_at,
        GROUP_CONCAT(
          CONCAT(ti.product_id, ':', p.title, ':', ti.price, ':', ti.quantity) 
          SEPARATOR '|'
        ) as products
      FROM transactions t
      JOIN transaction_items ti ON t.id = ti.transaction_id
      JOIN products p ON ti.product_id = p.id
      WHERE t.user_id = ? AND t.customer_id = ?
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `, [req.user.id, req.customer_id]);
    
    // Format the response
    const formattedTransactions = transactions.map(transaction => ({
      id: transaction.id,
      bill_number: transaction.bill_number,
      total_price: transaction.total_price,
      created_at: transaction.created_at,
      products: transaction.products ? transaction.products.split('|').map(product => {
        const [product_id, title, price, quantity] = product.split(':');
        return {
          product_id: parseInt(product_id),
          title,
          price: parseFloat(price),
          quantity: parseInt(quantity)
        };
      }) : []
    }));
    
    res.json(formattedTransactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ==================== EXTERNAL PRODUCT API INTEGRATION ====================

// Get products from external wichxshop API
app.get('/api/external/products', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    // Fetch products from external API
    const response = await axios.get('https://wichxshop.com/api/v1/store/product', {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Return the response from external API
    res.json(response.data);

  } catch (error) {
    console.error('External products API error:', error);
    
    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        message: 'Error fetching products from external API',
        error: error.response.data || 'API error'
      });
    }

    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการเชื่อมต่อกับ external API',
      error: error.message
    });
  }
});

// Import products from external API to local database
app.post('/api/external/products/import', authenticateToken, requirePermission('can_edit_products'), async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const { category_id, overwrite = false } = req.body;

    // Validate category_id
    if (!category_id) {
      return res.status(400).json({
        success: false,
        message: 'Category ID is required for importing products'
      });
    }

    // Check if category exists for this customer
    const [categoryCheck] = await connection.execute(
      'SELECT id, title FROM categories WHERE id = ? AND customer_id = ? AND isActive = 1',
      [category_id, req.customer_id]
    );

    if (categoryCheck.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Category not found or inactive'
      });
    }

    // Fetch products from external API
    const response = await axios.get('https://wichxshop.com/api/v1/store/product', {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.data.success || !response.data.data || !Array.isArray(response.data.data)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid response from external API'
      });
    }

    const externalProducts = response.data.data;
    const importedProducts = [];
    const skippedProducts = [];
    const errors = [];

    for (const extProduct of externalProducts) {
      try {
        // Map external product fields to database fields
        const title = extProduct.name || 'Untitled Product';
        const price = parseFloat(extProduct.price) || 0;
        const image = extProduct.image || null;
        const stock = parseInt(extProduct.stock) || 0;
        const discountValue = extProduct.discountValue ? parseFloat(extProduct.discountValue) : 0;
        const discountType = extProduct.discountType || 'NONE';
        
        // Calculate discount_percent based on discountType
        let discount_percent = 0;
        if (discountType === 'FIXED_AMOUNT' && price > 0 && discountValue > 0) {
          discount_percent = Math.round((discountValue / price) * 100);
        } else if (discountType !== 'NONE' && discountValue > 0 && price > 0) {
          discount_percent = Math.round((discountValue / price) * 100);
        }

        // Build subtitle from additional info
        let subtitle = null;
        const subtitleParts = [];
        if (extProduct.isPreorder) {
          subtitleParts.push('(พรีออเดอร์)');
        }
        if (extProduct.slug) {
          subtitleParts.push(`Slug: ${extProduct.slug}`);
        }
        if (subtitleParts.length > 0) {
          subtitle = subtitleParts.join(' | ');
        }

        // Check if product already exists (by title in this category)
        const [existingProducts] = await connection.execute(
          'SELECT id FROM products WHERE customer_id = ? AND category_id = ? AND title = ?',
          [req.customer_id, category_id, title]
        );

        if (existingProducts.length > 0) {
          if (overwrite) {
            // Update existing product
            await connection.execute(
              `UPDATE products SET 
                price = ?, 
                image = ?, 
                stock = ?, 
                discount_percent = ?,
                subtitle = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND customer_id = ?`,
              [price, image, stock, discount_percent, subtitle, existingProducts[0].id, req.customer_id]
            );
            importedProducts.push({
              id: existingProducts[0].id,
              title: title,
              action: 'updated'
            });
          } else {
            skippedProducts.push({
              title: title,
              reason: 'Product already exists'
            });
          }
          continue;
        }

        // Insert new product
        const [result] = await connection.execute(
          `INSERT INTO products (
            customer_id, category_id, title, subtitle, price, reseller_price, 
            stock, duration, image, download_link, isSpecial, featured, 
            isWarrenty, warrenty_text, primary_color, secondary_color, 
            priority, discount_percent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.customer_id, 
            category_id, 
            title, 
            subtitle, 
            price, 
            null, // reseller_price
            stock, 
            null, // duration
            image, 
            extProduct.slug || null, // download_link
            0, // isSpecial
            0, // featured
            0, // isWarrenty
            extProduct.isPreorder ? 'สินค้าพรีออเดอร์' : null, // warrenty_text
            null, // primary_color
            null, // secondary_color
            0, // priority
            discount_percent
          ]
        );

        importedProducts.push({
          id: result.insertId,
          title: title,
          action: 'created'
        });

      } catch (productError) {
        console.error(`Error importing product "${extProduct.name}":`, productError);
        errors.push({
          product: extProduct.name || 'Unknown',
          error: productError.message
        });
      }
    }

    await connection.commit();

    res.json({
      success: true,
      message: 'Products imported successfully',
      summary: {
        total_external_products: externalProducts.length,
        imported: importedProducts.length,
        skipped: skippedProducts.length,
        errors: errors.length
      },
      imported_products: importedProducts,
      skipped_products: skippedProducts,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    await connection.rollback();
    console.error('Import products error:', error);
    
    if (error.response) {
      return res.status(500).json({
        success: false,
        message: 'Error fetching products from external API',
        error: error.response.data || 'API error'
      });
    }

    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการ import สินค้า',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

// Get latest transactions (Multi-tenant version - public access)
app.get('/api/latest-transactions-by-customer', async (req, res) => {
  try {
    // Check if customer_id is available
    if (!req.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer context required'
      });
    }

    const limit = parseInt(req.query.limit) || 10;
    
    // Query to get latest transactions for the current customer only
    const [results] = await pool.execute(`
      WITH RankedTransactions AS (
        SELECT 
          t.id,
          t.customer_id,
          t.bill_number,
          t.user_id,
          t.total_price,
          t.created_at,
          u.fullname,
          u.email,
          auth.website_name,
          ROW_NUMBER() OVER (PARTITION BY t.customer_id ORDER BY t.created_at DESC) as row_num
        FROM transactions t
        LEFT JOIN users u ON t.user_id = u.id AND u.customer_id = ?
        LEFT JOIN auth_sites auth ON t.customer_id = auth.customer_id
        WHERE t.customer_id = ?
        GROUP BY t.id, t.customer_id, t.bill_number, t.user_id, t.total_price, t.created_at, u.fullname, u.email, auth.website_name
      )
      SELECT 
        rt.*,
        ti.id as item_id,
        ti.product_id,
        ti.quantity,
        ti.price as item_price,
        p.title as product_title,
        p.image as product_image
      FROM RankedTransactions rt
      LEFT JOIN transaction_items ti ON rt.id = ti.transaction_id
      LEFT JOIN products p ON ti.product_id = p.id AND p.customer_id = ?
      WHERE rt.row_num <= ?
      ORDER BY rt.customer_id ASC, rt.created_at DESC, ti.id ASC
    `, [req.customer_id, req.customer_id, req.customer_id, limit]);
    
    // Group by customer_id and transaction_id
    const groupedData = {};
    const transactionMap = new Map();
    
    results.forEach(row => {
      const customerId = row.customer_id;
      const transactionId = row.id;
      
      // Create customer group if not exists
      if (!groupedData[customerId]) {
        groupedData[customerId] = {
          customer_id: customerId,
          website_name: row.website_name,
          transactions: []
        };
      }
      
      // Create transaction if not exists
      if (!transactionMap.has(transactionId)) {
        const transaction = {
          id: row.id,
          bill_number: row.bill_number,
          user_id: row.user_id,
          user_fullname: row.fullname,
          user_email: row.email,
          total_price: parseFloat(row.total_price),
          created_at: row.created_at,
          products: []
        };
        transactionMap.set(transactionId, transaction);
        groupedData[customerId].transactions.push(transaction);
      }
      
      // Add product to transaction
      if (row.item_id) {
        transactionMap.get(transactionId).products.push({
          product_id: row.product_id,
          title: row.product_title,
          image: row.product_image,
          quantity: row.quantity,
          price: parseFloat(row.item_price)
        });
      }
    });
    
    // Convert to array
    const responseData = Object.values(groupedData);
    
    res.json({
      success: true,
      message: 'Latest transactions by customer retrieved successfully',
      data: responseData,
      total_customers: responseData.length,
      limit_per_customer: limit
    });
    
  } catch (error) {
    console.error('Error fetching latest transactions by customer:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Test database connection at: http://localhost:${PORT}/test-db`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await pool.end();
  process.exit(0);
});
