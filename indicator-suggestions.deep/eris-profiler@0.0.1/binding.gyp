# DEFANGED: static-analysis cache — do not execute
{
  'targets': [
    {
      'target_name': 'profiler',
      'sources': [
        'profiler.cc'
      ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ] 
    }
  ]
}